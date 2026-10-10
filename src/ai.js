// Optional AI-written report prose (`ownh report --ai`): an executive summary,
// an OKR draft, and names for the owner archetypes. Talks to any
// OpenRouter-compatible chat completions API.
//
// Rules that keep this honest:
// - The model sees aggregates only. Every owner and every repository is
//   replaced by a token ([O1], [R1], ...) before the request; tokens are mapped
//   back to real names locally. No code text is ever sent.
// - Every number in the model's text must match a number in the facts it was
//   given (within rounding). Otherwise the answer is rejected and retried, and
//   finally withheld. OWNH computes the figures; the model only writes prose.
// - Answers are cached by a hash of model, prompt version, and facts, so a
//   report rebuilt from the same database reuses the same text.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PROMPT_VERSION = 1;
// Default model (user decision); override with OWNH_AI_MODEL.
export const DEFAULT_MODEL = 'openai/gpt-6-luna';
const MAX_ATTEMPTS = 3;
const CACHE_FILE = 'ai-cache.json';

export function aiConfig(env = process.env) {
  return {
    key: env.OWNH_AI_KEY || env.OPENROUTER_API_KEY || null,
    model: env.OWNH_AI_MODEL || DEFAULT_MODEL,
    baseUrl: (env.OWNH_AI_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
  };
}

// --- pseudonyms ------------------------------------------------------------------

// Owners in rank order become [O1], [O2], ...; repositories by size [R1], [R2], ...
export function pseudonyms(stats) {
  const owners = stats.owners.filter((o) => o.owner);
  const ownerToken = new Map(owners.map((o, i) => [o.owner.email, `[O${i + 1}]`]));
  const repos = [...stats.repos].sort((a, b) => b.lines - a.lines || (a.name < b.name ? -1 : 1));
  const repoToken = new Map(repos.map((r, i) => [r.name, `[R${i + 1}]`]));
  const names = new Map([
    ...owners.map((o, i) => [`[O${i + 1}]`, o.owner.name]),
    ...repos.map((r, i) => [`[R${i + 1}]`, r.name]),
  ]);
  return {
    owner: (owner) => (owner ? ownerToken.get(owner.email) ?? null : null),
    repo: (name) => repoToken.get(name) ?? null,
    known: (token) => names.has(token),
    unmap: (text) => text.replace(/\[[OR]\d+\]/g, (t) => names.get(t) ?? t),
  };
}

// --- facts -----------------------------------------------------------------------

const pct = (v) => Math.round(v * 1000) / 10; // share -> percent, one decimal
const TRIVIAL = /^[\s{}()[\];,.:<>/\\*#'"`=+-]*$/;

function lineKind(l) {
  if (l.binary === null) return 'unattributed';
  if (l.binary) return 'binary file';
  if (l.text.trim() === '') return l.text === '' ? 'blank line' : 'whitespace-only line';
  if (TRIVIAL.test(l.text)) return 'punctuation-only line (braces, brackets)';
  return 'code line';
}

// Everything the model may use. Names are tokens; shares are percentages.
export function buildFacts(stats, archetypes, p) {
  const t = stats.timeline;
  const proj = t?.projections;
  const shareProj = (x) => (x ? { status: x.status, currentPct: pct(x.current), quarter: x.quarter ?? null, r2: x.fit ? Math.round(x.fit.r2 * 100) / 100 : null } : null);
  return {
    repositories: stats.repos.length,
    linesUnderManagement: stats.total,
    owners: stats.owners.filter((o) => o.owner).length,
    topOwners: stats.owners.filter((o) => o.owner).slice(0, 5).map((o) => ({ owner: p.owner(o.owner), sharePct: pct(o.lines / stats.total), commits: o.commits })),
    topLines: stats.lines.slice(0, 5).map((l) => ({ kind: lineKind(l), copies: l.lines, sharePct: pct(l.lines / stats.total), owner: p.owner(l.owner) })),
    crossRepository: [...stats.repos].sort((a, b) => b.foreign / (b.lines || 1) - a.foreign / (a.lines || 1)).slice(0, 5).map((r) => ({
      repository: p.repo(r.name),
      writtenElsewherePct: pct(r.lines ? r.foreign / r.lines : 0),
      ownedByNonContributorsPct: pct(r.lines ? r.absentee / r.lines : 0),
    })),
    methodsAgreeIn: stats.repos.filter((r) => r.methods?.agree).length,
    outlook: t ? {
      now: t.nowLabel,
      inactiveOwnersMajority: shareProj(proj.knowledgeLoss),
      principalOwnerMajority: shareProj(proj.principal),
      blankLines: proj.blank ? { committed: proj.blank.current, nextMilestone: proj.blank.milestone, status: proj.blank.status, quarter: proj.blank.quarter ?? null } : null,
      lastQuarters: t.kpis.slice(-4).map((k) => ({
        quarter: k.quarter,
        lines: k.lines,
        linesChangePct: k.linesChange === null ? null : pct(k.linesChange),
        principalOwnerPct: pct(k.principalShare),
        inactiveOwnersPct: pct(k.inactiveShare),
      })),
    } : null,
    survival: stats.survival?.all?.halfLife ? { halfLifeYears: Math.round((stats.survival.all.halfLife / 4) * 10) / 10, projected: stats.survival.all.projected } : null,
    demolition: stats.deletions ? {
      linesAdded: stats.deletions.added,
      linesRemoved: stats.deletions.removed,
      removedFromOthersPct: pct(stats.deletions.removed ? stats.deletions.removedOfOthers / stats.deletions.removed : 0),
      topRemover: stats.deletions.topRemovers[0] ? { owner: p.owner(stats.deletions.topRemovers[0].owner), lines: stats.deletions.topRemovers[0].lines } : null,
    } : null,
    archetypes: archetypes.map((a) => ({ key: a.key, rule: a.rule, members: a.members, sharePct: pct(a.share), examples: a.examples.map((o) => p.owner(o)) })),
  };
}

// --- prompt ----------------------------------------------------------------------

const SYSTEM = `You write for OWNH, a code ownership analytics product. OWNH assigns each line of code to the first person who ever wrote it. Your voice is a senior corporate analyst briefing an executive board: confident, polished, upbeat, deadpan. Never joke, wink, or question the methodology.

Strict rules:
- Use only the facts provided. Every number you write must appear in the facts (you may round percentages to whole numbers).
- People and repositories appear as tokens like [O1] or [R2]. Use the tokens exactly as given; never invent new tokens or names.
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
// rounding (0.5 absolute, or 1% relative for large counts).
function numbersIn(text) {
  return (text.replace(/\[[OR]\d+\]/g, ' ').match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => Number(n.replace(/,/g, '')));
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
    for (const token of text.match(/\[[A-Z]+\d+\]/g) ?? []) if (!p.known(token)) problems.push(`unknown token ${token}`);
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

export async function chatCompletion(config, messages) {
  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.key}`,
      'content-type': 'application/json',
      'http-referer': 'https://ownh.org',
      'x-title': 'OWNH',
    },
    body: JSON.stringify({ model: config.model, messages, temperature: 0 }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`AI request failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('AI response had no message content');
  return content;
}

// Returns { model, promptVersion, cached, summary, okr, archetypeNames } with
// real names restored, or { withheld: reason }.
export async function aiInsights(stats, archetypes, { config, outDir, complete = chatCompletion, log = () => {} }) {
  const p = pseudonyms(stats);
  const facts = buildFacts(stats, archetypes, p);
  const key = createHash('sha256').update(JSON.stringify({ model: config.model, version: PROMPT_VERSION, facts })).digest('hex');
  const cachePath = join(outDir, CACHE_FILE);
  const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : null;

  let answer = cache?.key === key ? cache.answer : null;
  const cached = Boolean(answer);
  // A cached answer needs no key; only a new request does.
  if (!answer && !config.key) return { withheld: 'no API key (set OWNH_AI_KEY or OPENROUTER_API_KEY)' };
  if (!answer) {
    const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: userPrompt(facts) }];
    let problems = [];
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      log(`ai: request ${attempt}/${MAX_ATTEMPTS} to ${config.model}`);
      const content = await complete(config, messages);
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
