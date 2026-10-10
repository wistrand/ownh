// Optional AI-written report prose (`ownh report --ai`): an executive summary,
// an OKR draft, and names for the owner archetypes. Talks to any
// OpenRouter-compatible chat completions API.
//
// What leaves the machine is kept to a minimum:
// - No names: owners, repositories, and quarters are tokens ([O1], [R1], [T0],
//   [T-3]), mapped back to real names and dates locally. No code text, paths,
//   commit messages, or emails.
// - No absolute numbers: only percentages, ratios, a half-life in years, and
//   coarse size bands ("tens of millions"), so the provider can't size the
//   organization. Top lists are cut to three.
// - No attribution headers; on OpenRouter the request asks for providers that
//   neither store nor train on data (data_collection "deny") and, by default,
//   zero-data-retention endpoints only.
// - The exact request (minus the key) is written to ai-request.json next to the
//   report; `--ai-dry-run` writes it without sending anything.
//
// Every number in the model's text must match a number in the facts it was
// given (within rounding), or the answer is rejected and retried, and finally
// withheld. Answers are cached by a hash of model, prompt version, and facts.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { quarterLabel } from './timeline.js';

export const PROMPT_VERSION = 2;
// Default model (user decision); override with OWNH_AI_MODEL.
export const DEFAULT_MODEL = 'openai/gpt-6-luna';
const MAX_ATTEMPTS = 3;
const CACHE_FILE = 'ai-cache.json';
export const REQUEST_FILE = 'ai-request.json';
const TOP = 3;

export function aiConfig(env = process.env) {
  const baseUrl = (env.OWNH_AI_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
  return {
    key: env.OWNH_AI_KEY || env.OPENROUTER_API_KEY || null,
    model: env.OWNH_AI_MODEL || DEFAULT_MODEL,
    baseUrl,
    // OpenRouter routing restrictions; other APIs may reject the extra field.
    openRouter: /(^|\.)openrouter\.ai\//.test(`${baseUrl}/`.replace(/^https?:\/\//, '')),
    // Zero-data-retention endpoints only, unless OWNH_AI_ZDR=0.
    zdr: env.OWNH_AI_ZDR !== '0',
    // 0 by default; OWNH_AI_TEMPERATURE=default omits the parameter (some models
    // accept only their default). A model that rejects 0 is retried without it.
    temperature: env.OWNH_AI_TEMPERATURE === 'default' ? null
      : env.OWNH_AI_TEMPERATURE !== undefined && env.OWNH_AI_TEMPERATURE !== '' ? Number(env.OWNH_AI_TEMPERATURE) : 0,
  };
}

// --- pseudonyms ------------------------------------------------------------------

// Owners and repositories are numbered in the order they first appear in the
// facts ([O1], [O2], [R1], ...), not by rank or size, so a token number says
// nothing about how many owners or repositories exist or where one ranks.
// Quarters are relative to the newest commit's quarter: [T0], [T-4], [T+20].
export function pseudonyms(stats) {
  const ownerToken = new Map();
  const repoToken = new Map();
  const names = new Map();
  const assign = (map, prefix, key, name) => {
    if (!map.has(key)) {
      const token = `[${prefix}${map.size + 1}]`;
      map.set(key, token);
      names.set(token, name);
    }
    return map.get(key);
  };
  const now = stats.timeline?.now ?? null;
  return {
    owner: (owner) => (owner ? assign(ownerToken, 'O', owner.email, owner.name) : null),
    repo: (name) => (name ? assign(repoToken, 'R', name, name) : null),
    // A quarter label ("2026 Q2") or quarter number to its relative token. Only
    // tokens issued here are known, so the model can't invent a quarter.
    quarter: (q) => {
      if (q === null || q === undefined || now === null) return null;
      const n = typeof q === 'number' ? q : Number(q.slice(0, 4)) * 4 + Number(q.slice(-1)) - 1;
      const d = n - now;
      const token = `[T${d > 0 ? '+' : ''}${d}]`;
      names.set(token, quarterLabel(n));
      return token;
    },
    known: (token) => names.has(token),
    unmap: (text) => text.replace(TOKEN, (t) => names.get(t) ?? t),
  };
}

const TOKEN = /\[(?:[OR]\d+|T[+-]?\d+)\]/g;

// --- facts -----------------------------------------------------------------------

// Share -> percent with one decimal. Only for shares of large totals (all lines,
// all removals): a percentage of a small count can be reversed to the count.
const pct = (v) => Math.round(v * 1000) / 10;
// Shares of one repository: whole percents, since a small repo's line count
// could otherwise be recovered from the decimals.
const wholePct = (v) => Math.round(v * 100);
// Shares of a count (owners, repositories) as words. Any number, even in 5%
// steps, can be reversed when the total is small (2 of 6 repositories is 35%,
// which no other small total produces); coarse words map many counts to each.
function fraction(n, total) {
  if (!total || n === 0) return 'none';
  if (n === total) return 'all';
  const f = n / total;
  if (f < 0.1) return 'under a tenth';
  if (f < 0.25) return 'under a quarter';
  if (f < 0.45) return 'under half';
  if (f <= 0.55) return 'about half';
  if (f < 0.75) return 'over half';
  return 'over three quarters';
}

// How many owners are in a group, without revealing the total number of owners.
function ownerShare(members, total) {
  return members === 1 ? 'one owner' : `${fraction(members, total)} of owners`.replace(/^none of owners$/, 'no owners').replace(/^all of owners$/, 'all owners');
}

function ofRepositories(f) {
  return f === 'none' ? 'no repositories' : f === 'all' ? 'all repositories' : `${f} of repositories`;
}

const TRIVIAL = /^[\s{}()[\];,.:<>/\\*#'"`=+-]*$/;

function lineKind(l) {
  if (l.binary === null) return 'unattributed';
  if (l.binary) return 'binary file';
  if (l.text.trim() === '') return l.text === '' ? 'blank line' : 'whitespace-only line';
  if (TRIVIAL.test(l.text)) return 'punctuation-only line (braces, brackets)';
  return 'code line';
}

// Sizes as words, so no exact count leaves the machine.
function lineBand(n) {
  const bands = ['under a thousand', 'thousands', 'tens of thousands', 'hundreds of thousands', 'millions', 'tens of millions'];
  const i = Math.min(Math.max(0, Math.floor(Math.log10(Math.max(n, 1))) - 2), bands.length);
  return bands[i] ?? 'hundreds of millions';
}

function countBand(n) {
  // "dozens" overstates 10 to 24.
  return n < 10 ? 'fewer than ten' : n < 25 ? 'ten to two dozen' : n < 100 ? 'dozens' : n < 1000 ? 'hundreds' : 'thousands';
}

// Everything the model may use: tokens for names and quarters, percentages and
// bands for sizes. Precision is chosen so no count can be recovered: see pct,
// wholePct, fraction, ownerShare, and the archetypes' aiRule.
export function buildFacts(stats, archetypes, p) {
  const t = stats.timeline;
  const proj = t?.projections;
  const owners = stats.owners.filter((o) => o.owner);
  // `meaning` spells out each status, so a past event ("reached") is not
  // written as a milestone still to come.
  const shareProj = (x) => {
    if (!x) return null;
    const q = p.quarter(x.quarter ?? null);
    const meaning = {
      reached: `has held the majority since ${q}; this is past, not a target`,
      projected: `projected to reach the majority by ${q}`,
      beyond: `not projected to reach the majority before ${q}`,
      'not-on-track': 'trend flat or falling; no majority projected',
      insufficient: 'not enough history to project',
    }[x.status];
    return { status: x.status, meaning, currentPct: pct(x.current), quarter: q, r2: x.fit ? Math.round(x.fit.r2 * 100) / 100 : null };
  };
  const blankMeaning = (x) => {
    const q = p.quarter(x.quarter ?? null);
    return {
      projected: `next milestone projected for ${q}`,
      beyond: `next milestone not expected before ${q}`,
      'not-on-track': 'blank-line count flat or falling; no milestone projected',
      insufficient: 'not enough history to project',
    }[x.status];
  };
  const d = stats.deletions;
  return {
    scale: { repositories: countBand(stats.repos.length), owners: countBand(owners.length), lines: lineBand(stats.total) },
    topOwners: owners.slice(0, TOP).map((o) => ({ owner: p.owner(o.owner), sharePct: pct(o.lines / stats.total) })),
    topLines: stats.lines.slice(0, TOP).map((l) => ({ kind: lineKind(l), sharePct: pct(l.lines / stats.total), owner: p.owner(l.owner) })),
    crossRepository: [...stats.repos].sort((a, b) => b.foreign / (b.lines || 1) - a.foreign / (a.lines || 1)).slice(0, TOP).map((r) => ({
      repository: p.repo(r.name),
      writtenElsewherePct: wholePct(r.lines ? r.foreign / r.lines : 0),
      ownedByNonContributorsPct: wholePct(r.lines ? r.absentee / r.lines : 0),
    })),
    methodsAgreeIn: ofRepositories(fraction(stats.repos.filter((r) => r.methods?.agree).length, stats.repos.length)),
    outlook: t ? {
      now: p.quarter(t.now),
      inactiveOwnersMajority: shareProj(proj.knowledgeLoss),
      principalOwnerMajority: shareProj(proj.principal),
      nextBlankLineMilestone: proj.blank ? { status: proj.blank.status, meaning: blankMeaning(proj.blank), quarter: p.quarter(proj.blank.quarter ?? null) } : null,
      lastQuarters: t.kpis.slice(-4).map((k) => ({
        quarter: p.quarter(k.quarter),
        linesChangePct: k.linesChange === null ? null : pct(k.linesChange),
        principalOwnerPct: pct(k.principalShare),
        inactiveOwnersPct: pct(k.inactiveShare),
        // Without this the model reads a quarter that has barely started as a
        // stalled one ("0% line change").
        ...(t.inProgress && k.quarter === t.nowLabel ? { inProgress: 'quarter not finished; figures cover only part of it, do not read them as a trend' } : {}),
      })),
    } : null,
    survival: stats.survival?.all?.halfLife ? { halfLifeYears: Math.round((stats.survival.all.halfLife / 4) * 10) / 10, projected: stats.survival.all.projected } : null,
    demolition: d && d.added ? {
      removedPerAddedPct: pct(d.removed / d.added),
      removedFromOthersPct: pct(d.removed ? d.removedOfOthers / d.removed : 0),
      topRemover: d.topRemovers[0] ? { owner: p.owner(d.topRemovers[0].owner), shareOfRemovalsPct: pct(d.removed ? d.topRemovers[0].lines / d.removed : 0) } : null,
    } : null,
    archetypes: archetypes.map((a) => ({
      key: a.key,
      rule: a.aiRule,
      owners: ownerShare(a.members, owners.length),
      sharePct: pct(a.share),
      examples: a.examples.slice(0, 2).map((o) => p.owner(o)),
    })),
  };
}

// --- prompt ----------------------------------------------------------------------

const SYSTEM = `You write for OWNH, a code ownership analytics product. OWNH assigns each line of code to the first person who ever wrote it. Your voice is a senior corporate analyst briefing an executive board: confident, polished, upbeat, deadpan. Never joke, wink, or question the methodology.

Strict rules:
- Use only the facts provided. Every number you write must appear in the facts (you may round percentages to whole numbers). There are no absolute counts; describe size with the scale words given.
- People and repositories appear as tokens like [O1] or [R2]; quarters appear as tokens like [T0] (the latest quarter), [T-4], or [T+20]. Use tokens exactly as given; never invent tokens, names, or dates.
- Do not quote or invent code.
- Reply with JSON only, no prose outside it, in this shape:
{"summary": ["paragraph", "paragraph", "paragraph"],
 "okr": {"objective": "one sentence", "keyResults": [{"text": "one sentence with a baseline from the facts", "status": "on track" | "at risk" | "off track"}]},
 "archetypes": {"<archetype key>": "a 2 to 4 word name"}}
- summary: exactly 3 short paragraphs for executives.
- okr: one objective and exactly 3 key results; base each status on the trends in the facts.
- archetypes: a memorable name for every archetype key given.`;

function userPrompt(facts) {
  return `Facts (JSON):\n${JSON.stringify(facts, null, 2)}`;
}

// --- validation ------------------------------------------------------------------

// Numbers allowed in the answer: every number in the facts, compared within
// rounding (0.5 absolute, or 1% relative above 100). Tokens are not numbers.
function numbersIn(text) {
  return (text.replace(TOKEN, ' ').match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => Number(n.replace(/,/g, '')));
}

export function checkAnswer(answer, facts, p) {
  const problems = [];
  if (!answer || typeof answer !== 'object') return ['The reply is not a JSON object.'];
  const { summary, okr, archetypes } = answer;
  if (!Array.isArray(summary) || summary.length !== 3 || !summary.every((x) => typeof x === 'string')) problems.push('summary must be 3 strings');
  if (!okr || typeof okr.objective !== 'string' || !Array.isArray(okr.keyResults) || okr.keyResults.length !== 3) problems.push('okr must have an objective and 3 keyResults');
  else if (!okr.keyResults.every((k) => typeof k.text === 'string' && ['on track', 'at risk', 'off track'].includes(k.status))) problems.push('each key result needs text and a status of "on track", "at risk", or "off track"');
  const keys = facts.archetypes.map((a) => a.key);
  if (!archetypes || typeof archetypes !== 'object' || !keys.every((k) => typeof archetypes[k] === 'string')) problems.push(`archetypes must name every key: ${keys.join(', ')}`);
  if (problems.length) return problems;

  const texts = [...summary, okr.objective, ...okr.keyResults.map((k) => k.text), ...Object.values(archetypes)];
  const allowed = numbersIn(JSON.stringify(facts));
  const ok = (n) => allowed.some((a) => Math.abs(a - n) <= 0.5 || (a > 100 && Math.abs(a - n) / a <= 0.01));
  for (const text of texts) {
    for (const token of text.match(/\[[A-Z]+[+-]?\d+\]/g) ?? []) if (!p.known(token)) problems.push(`unknown token ${token}`);
    for (const n of numbersIn(text)) if (!ok(n)) problems.push(`the number ${n} is not in the facts`);
  }
  return [...new Set(problems)];
}

function parseJson(content) {
  const body = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(body);
  } catch {
    const m = body.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch { return null; }
  }
}

// --- API -------------------------------------------------------------------------

// The JSON body sent to the API. Also what ai-request.json records.
export function requestBody(config, messages) {
  return {
    model: config.model,
    messages,
    ...(config.temperature === null || config.temperature === undefined ? {} : { temperature: config.temperature }),
    ...(config.openRouter ? { provider: { data_collection: 'deny', ...(config.zdr ? { zdr: true } : {}) } } : {}),
  };
}

export async function chatCompletion(config, messages) {
  const post = (cfg) => fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    // Only what the API needs: no referer or app-title attribution headers.
    headers: { authorization: `Bearer ${cfg.key}`, 'content-type': 'application/json' },
    body: JSON.stringify(requestBody(cfg, messages)),
    signal: AbortSignal.timeout(180_000),
  });
  let res = await post(config);
  if (res.status === 400 && config.temperature !== null && config.temperature !== undefined) {
    // Some models accept only their default temperature; retry without it.
    const text = await res.text();
    if (!/temperature/i.test(text)) throw new Error(`AI request failed: HTTP 400 ${text.slice(0, 300)}`);
    config.temperature = null;
    res = await post(config);
  }
  if (!res.ok) throw new Error(`AI request failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('AI response had no message content');
  return content;
}

// Returns { model, promptVersion, cached, summary, okr, archetypeNames } with
// real names restored, or { withheld: reason }.
//   dryRun     write ai-request.json, send nothing
//   cacheOnly  use a cached answer if there is one, never send
export async function aiInsights(stats, archetypes, { config, outDir, complete = chatCompletion, log = () => {}, dryRun = false, cacheOnly = false }) {
  const p = pseudonyms(stats);
  const facts = buildFacts(stats, archetypes, p);
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: userPrompt(facts) }];
  const audit = () => writeFileSync(join(outDir, REQUEST_FILE), `${JSON.stringify({
    note: 'The exact request OWNH sends (the API key is sent as an Authorization header and is not shown). Names and quarters are tokens, mapped back locally.',
    url: `${config.baseUrl}/chat/completions`,
    headers: ['authorization: Bearer <key>', 'content-type: application/json'],
    body: requestBody(config, messages),
  }, null, 2)}\n`);

  if (dryRun) {
    audit();
    return { withheld: `dry run: the request was written to ${REQUEST_FILE} and nothing was sent` };
  }
  const key = createHash('sha256').update(JSON.stringify({ model: config.model, version: PROMPT_VERSION, facts })).digest('hex');
  const cachePath = join(outDir, CACHE_FILE);
  const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : null;

  let answer = cache?.key === key ? cache.answer : null;
  const cached = Boolean(answer);
  if (!answer && cacheOnly) return { withheld: 'no cached AI text for this data (run with --ai to request it)' };
  // A cached answer needs no key; only a new request does.
  if (!answer && !config.key) return { withheld: 'no API key (set OWNH_AI_KEY or OPENROUTER_API_KEY)' };
  if (!answer) {
    let problems = [];
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      log(`ai: request ${attempt}/${MAX_ATTEMPTS} to ${config.model}`);
      // Written before sending (a record even if the process dies) and again
      // after, because chatCompletion may resend without temperature: the file
      // always shows the last request actually sent.
      audit();
      let content;
      try {
        content = await complete(config, messages);
      } catch (err) {
        audit();
        // An API failure withholds the AI sections; the rest of the report is written.
        return { withheld: err.message.replace(/\s+/g, ' ').slice(0, 300) };
      }
      audit();
      const parsed = parseJson(content);
      problems = parsed ? checkAnswer(parsed, facts, p) : ['The reply is not valid JSON.'];
      if (problems.length === 0) {
        answer = parsed;
        break;
      }
      log(`ai: rejected (${problems.slice(0, 3).join('; ')})`);
      messages.push({ role: 'assistant', content }, { role: 'user', content: `Fix these problems and reply with the full JSON again:\n- ${problems.join('\n- ')}` });
    }
    if (!answer) return { withheld: `the model's text failed verification ${MAX_ATTEMPTS} times (${problems.slice(0, 3).join('; ')})` };
    writeFileSync(cachePath, `${JSON.stringify({ key, model: config.model, promptVersion: PROMPT_VERSION, answer }, null, 2)}\n`);
  }

  return {
    model: config.model,
    promptVersion: PROMPT_VERSION,
    cached,
    summary: answer.summary.map(p.unmap),
    okr: {
      objective: p.unmap(answer.okr.objective),
      keyResults: answer.okr.keyResults.map((k) => ({ text: p.unmap(k.text), status: k.status })),
    },
    archetypeNames: Object.fromEntries(Object.entries(answer.archetypes).map(([k, v]) => [k, p.unmap(v)])),
  };
}
