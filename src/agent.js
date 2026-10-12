// `ownh agent`: ask questions about a database in a terminal session. A model
// (the same OpenAI-compatible endpoint, key, and settings as `report --ai`)
// answers by calling read-only tools over the database's stats.
//
// Privacy (user decision for this command): names, emails, repository names,
// paths, line text, and CODEOWNERS handles never reach the model. They are
// replaced by tokens ([O3] an owner, [R2] a repository, [F1] a path or pattern,
// [L4] a line, [D2] a declared owner), in tool results and in the user's own
// questions, and mapped back locally before anything is shown. Counts,
// percentages, and quarters are sent: unlike the report prose, answers here
// are expected to be exact. Every request is appended to agent-requests.jsonl
// in the report directory, as sent.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { chatMessage } from './ai.js';
import { ARCHETYPE_TITLES, findArchetypes } from './archetypes.js';
import { TRIVIAL_LINE, findOddities, groupFindings } from './oddities.js';
import { leverage } from './sections.js';
import { ACTIVE_WINDOW, quarterLabel, quarterOf } from './quarters.js';
import { repoCount } from './stats.js';

export const AGENT_LOG = 'agent-requests.jsonl';
const MAX_ROUNDS = 8;
// Tokens for every kind of name, in both directions. `people` lists every
// identity ({ owner: { name, email }, aliases: [names] }), including people
// who own no lines and every name they committed under; without it, the
// owners in stats.
export function agentPseudonyms(stats, people = null) {
  const everyone = people ?? stats.owners.filter((o) => o.owner).map((o) => ({ owner: o.owner, aliases: [] }));
  const byKey = new Map(); // `${prefix}:${key}` -> token
  const byToken = new Map(); // token -> { prefix, key, display }
  const counters = {};
  const token = (prefix, key, display) => {
    const k = `${prefix}:${key}`;
    let t = byKey.get(k);
    if (!t) {
      counters[prefix] = (counters[prefix] ?? 0) + 1;
      t = `[${prefix}${counters[prefix]}]`;
      byKey.set(k, t);
      byToken.set(t, { prefix, key, display });
    }
    return t;
  };
  // People who share a display name (an author with two emails) are shown with
  // their email locally, so they are told apart; the model only sees tokens.
  const nameCount = new Map();
  for (const { owner } of everyone) nameCount.set(owner.name, (nameCount.get(owner.name) ?? 0) + 1);
  const display = (o) => ((nameCount.get(o.name) ?? 0) > 1 ? `${o.name} <${o.email}>` : o.name);
  const p = {
    owner: (o) => (o ? token('O', o.email, display(o)) : null),
    repo: (name) => (name === null || name === undefined ? null : token('R', name, name)),
    path: (path) => (path ? token('F', path, path) : null),
    line: (l) => token('L', l.binary ? `bin:${l.path}` : `txt:${l.text}`, l.binary ? `(binary) ${l.path}` : JSON.stringify(l.text)),
    team: (handle) => token('D', handle, handle),
    resolve: (t) => byToken.get(String(t).trim()) ?? null,
    unmap: (text) => String(text ?? '').replace(/\[[A-Z]\d+\]/g, (t) => byToken.get(t)?.display ?? t),
  };

  // The user's own text. Replaced before sending, longest first, whole words:
  //   emails, and names of more than one word: any case
  //   one-word names ("Mark", "TJ"): exact case only, so ordinary words survive
  //   a name shared by several people: all their tokens ("[O3] or [O9]")
  //   repository names with a non-letter ("billing-api"): any case
  //   repository names that are plain words ("tools"): only in backticks
  //   or quotes, or next to "repo"/"repository", since the word means itself
  //   CODEOWNERS handles and patterns, and paths, that appear in the stats
  // A leading "@" does not protect a name: "@Mark" is a mention of Mark.
  const word = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const bound = (s) => `(?<![\\w.-])${word(s)}(?![\\w@-])`;
  const byName = new Map();
  const addName = (name, owner) => {
    if (!name || name.length < 2) return;
    if (!byName.has(name)) byName.set(name, new Map());
    byName.get(name).set(owner.email, owner);
  };
  for (const { owner, aliases } of everyone) {
    addName(owner.name, owner);
    for (const a of aliases) addName(a, owner);
  }
  const rules = [];
  for (const { owner } of everyone) {
    if (owner.email && owner.email.length >= 3) rules.push({ len: owner.email.length, re: new RegExp(bound(owner.email), 'gi'), to: () => p.owner(owner) });
  }
  for (const [name, list] of byName) {
    const multi = /\s/.test(name.trim());
    // A lowercase one-word name that is also a word of the agent's own prompt
    // ("or", "it") would rewrite the question's ordinary words; other short
    // names ("ff") are still replaced.
    const common = !multi && name === name.toLowerCase();
    const to = (m) => (common && p.vocabulary.has(m) ? m : [...list.values()].map(p.owner).join(' or '));
    rules.push({ len: name.length, re: new RegExp(bound(name), multi ? 'gi' : 'g'), to });
  }
  for (const r of stats.repos) {
    const tok = () => p.repo(r.name);
    if (/[^A-Za-z]/.test(r.name)) {
      rules.push({ len: r.name.length, re: new RegExp(bound(r.name), 'gi'), to: tok });
    } else {
      const n = word(r.name);
      rules.push({ len: r.name.length, re: new RegExp(`([\`"'])${n}\\1`, 'gi'), to: (m, q) => `${q}${tok()}${q}` });
      rules.push({ len: r.name.length, re: new RegExp(`\\b(repos?|repository)\\s+${n}\\b`, 'gi'), to: (m, w) => `${w} ${tok()}` });
      rules.push({ len: r.name.length, re: new RegExp(`\\b${n}(\\s+(?:repos?|repository))\\b`, 'gi'), to: (m, w) => `${tok()}${w}` });
    }
  }
  // Paths, CODEOWNERS patterns, and handles known to the stats: the tools
  // return them as tokens, so the user's text must not carry them out either.
  const literal = (text, to) => {
    if (typeof text === 'string' && text.length >= 3) rules.push({ len: text.length, re: new RegExp(`(?<![\\w./@-])${word(text)}(?![\\w/-])`, 'g'), to });
  };
  const seenLiteral = new Set();
  const collect = (x, key) => {
    if (Array.isArray(x)) {
      for (const v of x) {
        if (typeof v === 'string' && (key === 'owners' || key === 'unmatched' || key === 'shadowed') && !seenLiteral.has(v)) {
          seenLiteral.add(v);
          literal(v, () => (key === 'owners' ? p.team(v) : p.path(v)));
        } else collect(v);
      }
    } else if (x && typeof x === 'object') {
      for (const [k, v] of Object.entries(x)) {
        if ((k === 'path' || k === 'pattern') && typeof v === 'string' && !seenLiteral.has(v)) {
          seenLiteral.add(v);
          literal(v, () => p.path(v));
        } else collect(v, k);
      }
    }
  };
  collect(stats);
  rules.sort((a, b) => b.len - a.len);

  // Partial names, matched against the people as they are now, per question
  // (no prebuilt index): case and accents ignored, whole words only.
  const fold = (x) => x.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  const wordsOf = (x) => fold(x).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const namesOf = ({ owner, aliases }) => [owner.name, ...aliases].filter(Boolean);
  // People one word of the user's text names: a whole word of a multi-word
  // name ("lindqvist" in "Ada Lindqvist") of exactly one person. A one-word name
  // ("Mark") only matches in exact case (the rules above), so the ordinary
  // word "mark" survives. Several people, or none, leave the word alone.
  // Words of repository names ("analyzer" in "log-analyzer") are never taken
  // as a person's name: users mention repos by such words.
  const repoWords = new Set(stats.repos.flatMap((r) => wordsOf(r.name)));
  // The agent's own vocabulary (words of its prompt and tool descriptions, set
  // by agentSession): "hash" in "line hash" is never a name, even if someone
  // is called Hash, and a lowercase one-word name such as "or" is left alone.
  p.vocabulary = new Set();
  // One person can be several identities (an old and a new email) under the
  // same name; those all match, and get all their tokens.
  const onePerson = (word) => {
    const w = fold(word);
    if (repoWords.has(w) || p.vocabulary.has(w)) return [];
    const hits = new Map();
    for (const person of everyone) {
      const full = namesOf(person).find((n) => { const ws = wordsOf(n); return ws.length >= 2 && ws.includes(w); });
      if (full) hits.set(person.owner.email, { person, full: wordsOf(full).join(' ') });
    }
    const people = [...hits.values()];
    if (!people.length || new Set(people.map((h) => h.full)).size > 1) return [];
    return people.map((h) => h.person);
  };
  p.question = (text) => {
    let out = text;
    for (const { re, to } of rules) out = out.replace(re, to);
    // Then any remaining word of four or more letters that names exactly one
    // person ("lindqvist"): the fragment would otherwise leave the machine.
    // Words are runs of letters, so "lindqvist's" and "lindqvist-style" match
    // too, and a leading "@" does not hide one.
    out = out.replace(/(?<![\p{L}\p{M}\p{N}[.])\p{L}[\p{L}\p{M}]{3,}(?![\p{L}\p{M}\p{N}\]])/gu, (word) => {
      const people = onePerson(word);
      return people.length ? people.map((person) => p.owner(person.owner)).join(' or ') : word;
    });
    // "smith-jones" became "[O5]-[O5]".
    return out.replace(/(\[O\d+\])(?:-\1)+/g, '$1');
  };

  // Repository part of the find tool: repositories whose name matches `query`,
  // the same way as people (exact, whole word, part, then the closest typos).
  // The user's partial repository names are sent as typed (user decision); only
  // the matched names stay local.
  p.findRepos = (query) => {
    // A phrase that matches nothing as a whole ("the analyzer") is tried word by
    // word (four letters or more).
    const whole = findReposOf(query);
    if (whole.length) return whole;
    const words = wordsOf(String(query ?? '')).filter((w) => w.length >= 4);
    if (words.length < 2 && words[0] === fold(String(query ?? '')).trim()) return whole;
    const seen = new Map();
    for (const w of words) for (const f of findReposOf(w)) seen.set(f.owner?.email ?? f.name, f);
    return [...seen.values()];
  };
  const findReposOf = (query) => {
    const q = fold(String(query ?? '')).trim();
    if (q.length < 2) return [];
    const found = [];
    for (const r of stats.repos) {
      const n = fold(r.name);
      const match = n === q ? 'exact' : wordsOf(r.name).includes(q) ? 'word' : n.includes(q) ? 'partial' : null;
      if (match) found.push({ name: r.name, match });
    }
    if (found.length || q.length < 4) return found;
    const limit = q.length >= 6 ? 2 : 1;
    const near = stats.repos.map((r) => ({ name: r.name, d: Math.min(editDistance(fold(r.name), q), ...wordsOf(r.name).map((w) => editDistance(w, q))) }))
      .filter((x) => x.d <= limit);
    const best = Math.min(Infinity, ...near.map((x) => x.d));
    return near.filter((x) => x.d === best).map(({ name }) => ({ name, match: 'similar' }));
  };

  // People part of the find tool: people whose names or email name match
  // `query`, exact name first, then a whole word, then any part of a word.
  p.findPeople = (query) => {
    // A phrase that matches nothing as a whole ("the analyzer") is tried word by
    // word (four letters or more).
    const whole = findPeopleOf(query);
    if (whole.length) return whole;
    const words = wordsOf(String(query ?? '')).filter((w) => w.length >= 4);
    if (words.length < 2 && words[0] === fold(String(query ?? '')).trim()) return whole;
    const seen = new Map();
    for (const w of words) for (const f of findPeopleOf(w)) seen.set(f.owner?.email ?? f.name, f);
    return [...seen.values()];
  };
  const findPeopleOf = (query) => {
    const q = fold(String(query ?? '')).trim();
    if (q.length < 2) return [];
    const found = [];
    for (const person of everyone) {
      const names = namesOf(person);
      const local = person.owner.email ? person.owner.email.split('@')[0] : '';
      const all = [...names, local].filter(Boolean);
      let match = null;
      if (names.some((n) => fold(n) === q)) match = 'exact';
      else if (all.some((n) => wordsOf(n).includes(q))) match = 'word';
      else if (all.some((n) => fold(n).includes(q))) match = 'partial';
      if (match) found.push({ owner: person.owner, match });
    }
    if (found.length || q.length < 4) return found;
    // Nothing matched: try near misses (a typo in a name word), one edit for
    // short words, two from six letters on.
    // Only the closest near misses are kept, so a typo does not return everyone
    // whose name is two letters away.
    const limit = q.length >= 6 ? 2 : 1;
    let best = limit + 1;
    const near = [];
    for (const person of everyone) {
      const words = [...namesOf(person), person.owner.email ? person.owner.email.split('@')[0] : ''].flatMap(wordsOf);
      let d = limit + 1;
      for (const w of words) if (w.length >= 4 && Math.abs(w.length - q.length) <= limit) d = Math.min(d, editDistance(w, q));
      if (d <= limit) {
        near.push({ owner: person.owner, match: 'similar', d });
        best = Math.min(best, d);
      }
    }
    return near.filter((x) => x.d === best).map(({ owner, match }) => ({ owner, match }));
  };
  return p;
}

// Levenshtein distance, for the find tool's near misses.
function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

const share = (n, total) => (total ? Math.round((n / total) * 1000) / 10 : 0);

// Ownership entropy per method, rounded for the model: bits to two decimals,
// effective owners to one.
function entropyOf(methods) {
  const e = (x) => (x ? { bits: Math.round(x.bits * 100) / 100, effective_owners: Math.round(x.effectiveOwners * 10) / 10 } : null);
  const m = methods?.entropy ?? {};
  return { commits: e(m.commits), blame: e(m.blame), line_hash: e(m.hash) };
}

function kindOf(l) {
  if (l.binary === null) return 'unattributed';
  if (l.binary) return 'binary file';
  if (l.text === '') return 'blank line';
  return TRIVIAL_LINE.test(l.text) ? 'whitespace or punctuation only' : 'code';
}

// Tool definitions (OpenAI-compatible function calling) and their handlers.
// Every result is built from stats with names replaced by tokens.
// `db` (optional, read-only) adds the time-scoped tools, which query the
// database directly: removals per quarter range (churn is recorded per
// quarter) and commit activity between dates (commits have exact times).
export function agentTools(stats, p, db = null) {
  const owners = stats.owners.filter((o) => o.owner);
  const byEmail = new Map(owners.map((o) => [o.owner.email, o]));
  const now = stats.timeline?.now ?? null;
  const top = (t) => (t ? { owner: p.owner(t.owner), share_pct: Math.round(t.share * 1000) / 10, ...(t.estimate ? { estimated: true } : {}) } : null);
  const ownerArg = (t) => {
    const e = p.resolve(t);
    if (!e || e.prefix !== 'O') throw new Error(`unknown owner token ${t}`);
    return byEmail.get(e.key);
  };
  const repoArg = (t) => {
    const e = p.resolve(t);
    const r = e && e.prefix === 'R' ? stats.repos.find((x) => x.name === e.key) : null;
    if (!r) throw new Error(`unknown repository token ${t}`);
    return r;
  };
  // Commits and last commit time for someone who owns no lines (needs db).
  const activityOf = db ? db.prepare(`
    SELECT COUNT(*) AS commits, MAX(c.author_time) AS last
    FROM commits c JOIN identities i ON i.id = c.identity_id WHERE i.email = ?
  `) : null;
  const personActivity = (email) => (activityOf ? activityOf.get(email) : null);
  // Row counts from the model: a missing, null, or silly value means the default.
  // Some models send numbers as strings ("20").
  const count = (v, d) => {
    const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : v;
    return Number.isInteger(n) && n > 0 ? Math.min(n, 500) : d;
  };
  const ownerRow = (o, total) => ({
    owner: p.owner(o.owner), lines: o.lines, share_pct: share(o.lines, total),
  });
  const handlers = {
    overview: () => ({
      repositories: stats.repos.map((r) => ({ repo: p.repo(r.name), lines: r.lines, ownership_entropy: entropyOf(r.methods) })),
      lines_total: stats.total,
      owners_with_lines: owners.length,
      top_owners: owners.slice(0, 10).map((o) => ownerRow(o, stats.total)),
      methods_overall: { commits: top(stats.methods.commits), blame: top(stats.methods.blame), line_hash: top(stats.methods.hash), agree: stats.methods.agree },
      repositories_where_methods_agree: stats.repos.filter((r) => r.methods.agree).length,
      // Shannon entropy of each method's ownership shares (bits) and 2^bits,
      // the effective number of owners; per repository in `repositories`.
      ownership_entropy: entropyOf(stats.methods),
      now_quarter: now === null ? null : quarterLabel(now),
      now_quarter_in_progress: Boolean(stats.timeline?.inProgress),
    }),
    owners: ({ repo, limit, rank_by } = {}) => {
      const n = count(limit, 15);
      // Rankings can be by kind of line (each owner's composition, overall or in
      // the repository): "most punctuation" ranks every owner, not just the
      // owners of the top lines.
      const kind = ['code', 'blank', 'punctuation', 'binary'].includes(rank_by) ? rank_by : null;
      if (repo) {
        const r = repoArg(repo);
        const list = r.owners.filter((o) => o.owner);
        const rankedHere = kind
          ? list.filter((o) => o.composition && o.composition[kind] > 0)
            .sort((a, b) => b.composition[kind] - a.composition[kind] || (a.owner.email < b.owner.email ? -1 : 1))
          : list;
        const totalHere = kind ? list.reduce((t, o) => t + (o.composition?.[kind] ?? 0), 0) : r.lines;
        return {
          repo: p.repo(r.name),
          lines: r.lines,
          ranked_by: kind ? `${kind} lines owned in this repository` : 'lines owned in this repository',
          ...(kind ? { [`${kind}_lines_total`]: totalHere } : {}),
          owners: rankedHere.slice(0, n).map((o) => ({
            owner: p.owner(o.owner), lines: o.lines, share_pct: share(o.lines, r.lines), committed_here: o.contributor,
            ...(kind ? { [`${kind}_lines`]: o.composition[kind], [`share_of_${kind}_lines_here_pct`]: share(o.composition[kind], totalHere) } : {}),
            composition: o.composition,
          })),
        };
      }
      const ranked = kind
        ? owners.filter((o) => o.composition && o.composition[kind] > 0)
          .sort((a, b) => b.composition[kind] - a.composition[kind] || (a.owner.email < b.owner.email ? -1 : 1))
        : owners;
      const total = kind ? owners.reduce((t, o) => t + (o.composition?.[kind] ?? 0), 0) : stats.total;
      return {
        ranked_by: kind ? `${kind} lines owned` : 'lines owned',
        ...(kind ? { [`${kind}_lines_total`]: total } : { lines_total: stats.total }),
        owners: ranked.slice(0, n).map((o) => ({
          ...ownerRow(o, stats.total),
          ...(kind ? { [`${kind}_lines`]: o.composition[kind], [`share_of_all_${kind}_lines_pct`]: share(o.composition[kind], total) } : {}),
          composition: o.composition,
          commits: o.commits,
        })),
      };
    },
    owner_profile: ({ owner }) => {
      const o = ownerArg(owner);
      // People from removals or activity may own nothing at head.
      if (!o) return { owner, lines_owned: 0, note: 'owns no lines at head; see the removals and activity tools for what they did' };
      const last = o.lastCommit === null ? null : quarterOf(o.lastCommit);
      return {
        owner: p.owner(o.owner),
        rank: owners.indexOf(o) + 1,
        lines_owned: o.lines,
        share_of_all_lines_pct: share(o.lines, stats.total),
        commits: o.commits,
        lines_written: o.written,
        owned_per_line_written: o.written ? Math.round((o.lines / o.written) * 100) / 100 : null,
        composition: o.composition,
        last_commit_quarter: last === null ? null : quarterLabel(last),
        inactive: last !== null && now !== null && last <= now - ACTIVE_WINDOW,
        lines_of_others_removed: o.removedOthers,
        by_repository: stats.repos.flatMap((r) => {
          const i = r.owners.findIndex((x) => x.owner && x.owner.email === o.owner.email);
          return i < 0 ? [] : [{ repo: p.repo(r.name), lines: r.owners[i].lines, share_pct: share(r.owners[i].lines, r.lines), rank: i + 1, committed_here: r.owners[i].contributor }];
        }),
      };
    },
    repositories: () => stats.repos.map((r) => ({
      repo: p.repo(r.name),
      lines: r.lines,
      written_elsewhere_pct: share(r.foreign, r.lines),
      owned_by_non_contributors_pct: share(r.absentee, r.lines),
      origins: r.origins.slice(0, 3).map((x) => ({ repo: p.repo(x.repo), share_pct: share(x.lines, r.lines) })),
      top_owner: { commits: top(r.methods.commits), blame: top(r.methods.blame), line_hash: top(r.methods.hash), agree: r.methods.agree },
    })),
    top_lines: ({ limit } = {}) => stats.lines.slice(0, count(limit, 10)).map((l) => ({
      line: l.binary === null ? null : p.line(l), kind: kindOf(l), length: l.text?.length ?? null,
      copies: l.lines, share_pct: share(l.lines, stats.total), owner: p.owner(l.owner), first_written_in: p.repo(l.origin),
    })),
    outlook: () => {
      const t = stats.timeline;
      if (!t) return { available: false };
      const proj = (x) => (x ? { status: x.status, quarter: x.quarter ?? null, current_pct: x.current === undefined ? null : Math.round(x.current * 1000) / 10, r2: x.fit ? Math.round(x.fit.r2 * 100) / 100 : null } : null);
      return {
        mode: t.mode,
        // The series is added minus removed lines over all branches, not a
        // snapshot; it can differ from the lines at head (see the note).
        lines_at_head: t.headLines,
        note: t.mode === 'history'
          ? 'Quarterly lines are lines added minus lines removed over all branches; lines added on branches whose changes a merge discarded are never removed, so the latest value can differ from lines_at_head. This is expected.'
          : 'Quarterly lines count lines that exist today, by the quarter their owner first wrote them.',
        now_quarter: t.nowLabel,
        now_quarter_in_progress: Boolean(t.inProgress),
        quarters: t.kpis.map((k) => ({ quarter: k.quarter, lines: k.lines, change_pct: k.linesChange === null ? null : Math.round(k.linesChange * 1000) / 10, new_owners: k.newOwners, principal_owner_pct: Math.round(k.principalShare * 1000) / 10, inactive_owners_pct: Math.round(k.inactiveShare * 1000) / 10, blank_lines_committed: k.blank })),
        inactive_owners_majority: proj(t.projections.knowledgeLoss),
        principal_owner_majority: proj(t.projections.principal),
        next_blank_line_milestone: t.projections.blank ? { status: t.projections.blank.status, milestone: t.projections.blank.milestone, quarter: t.projections.blank.quarter ?? null } : null,
      };
    },
    deletions: () => {
      const d = stats.deletions;
      if (!d) return { available: false };
      const row = (r) => ({ owner: p.owner(r.owner), lines: r.lines, own_lines_removed: r.ownRemoved });
      return {
        lines_added: d.added, lines_removed: d.removed, removed_lines_owned_by_others: d.removedOfOthers,
        top_removers_of_others_lines: d.topRemovers.map(row),
        most_lines_lost_to_others: d.mostRemovedOwners.map(row),
        most_removed_line: d.mostRemovedLine ? { line: p.line(d.mostRemovedLine), kind: kindOf(d.mostRemovedLine), removals: d.mostRemovedLine.lines, owner: p.owner(d.mostRemovedLine.owner) } : null,
        restored: d.restored,
      };
    },
    survival: () => {
      const s = stats.survival;
      if (!s) return { available: false };
      const curve = (c) => (c ? { half_life_years: c.halfLife === null ? null : Math.round((c.halfLife / 4) * 10) / 10, projected: c.projected, surviving_pct_at_last_age: Math.round(c.curve.at(-1) * 1000) / 10, lines: c.lines } : null);
      return { all: curve(s.all), owners: s.owners.map((o) => ({ owner: p.owner(o.owner), ...curve(o) })) };
    },
    codeowners: ({ repo } = {}) => {
      if (!repo) {
        return stats.repos.filter((r) => r.declared).map((r) => ({
          repo: p.repo(r.name), rules_deciding_lines: r.declared.rules.length, rules_matching_no_file: r.declared.unmatchedRules,
          rules_overridden: r.declared.shadowedRules ?? 0, lines_covered_by_no_rule_pct: share(r.declared.noRule, r.declared.lines),
        }));
      }
      const r = repoArg(repo);
      if (!r.declared) return { repo: p.repo(r.name), codeowners: null };
      return {
        repo: p.repo(r.name),
        lines_covered_by_no_rule_pct: share(r.declared.noRule, r.declared.lines),
        rules: r.declared.rules.slice(0, 30).map((x) => ({
          pattern: p.path(x.pattern), declared_owners: x.owners.map(p.team), lines: x.lines,
          top_owner_by_line_hash: top(x.hash), top_owner_by_blame: top(x.blame),
        })),
        patterns_matching_no_file: (r.declared.unmatched ?? []).map(p.path),
        patterns_overridden_by_later_rules: (r.declared.shadowed ?? []).map(p.path),
      };
    },
    leverage: () => {
      const lev = leverage(stats);
      if (!lev) return { available: false };
      const row = (r) => ({ owner: p.owner(r.owner), lines_written: r.written, lines_owned: r.owned, owned_per_line_written: Math.round(r.ratio * 100) / 100 });
      return {
        definition: `lines owned today per line written; owners with fewer than ${Math.min(100, Math.ceil(stats.total * 0.01))} lines owned are not ranked`,
        highest: lev.highest.map(row),
        lowest_among_most_prolific_writers: lev.lowest.map(row),
      };
    },
    // Name lookup for people and repositories the model has no token for.
    // Runs locally; results carry tokens only, never the matched names. One
    // tool for both, so the model need not guess which kind a name is.
    find: ({ query, limit } = {}) => {
      const rank = { exact: 0, word: 1, partial: 2, similar: 3 };
      const n = count(limit, 10);
      const people = p.findPeople(query).map((f) => {
        const o = byEmail.get(f.owner.email);
        const activity = o ? null : personActivity(f.owner.email);
        const t = o ? o.lastCommit : activity?.last;
        return {
          person: p.owner(f.owner),
          match: f.match,
          lines_owned: o ? o.lines : 0,
          commits: o ? o.commits : activity?.commits ?? null,
          last_commit_quarter: t === null || t === undefined ? null : quarterLabel(quarterOf(t)),
        };
      }).sort((a, b) => rank[a.match] - rank[b.match] || b.lines_owned - a.lines_owned || (b.commits ?? 0) - (a.commits ?? 0));
      const repositories = p.findRepos(query).map((f) => ({ repo: p.repo(f.name), match: f.match, lines: stats.repos.find((x) => x.name === f.name).lines }))
        .sort((a, b) => rank[a.match] - rank[b.match] || b.lines - a.lines);
      return { query, people: people.slice(0, n), more_people: Math.max(0, people.length - n), repositories: repositories.slice(0, n) };
    },
    // The report's Material findings, built with tokens for every name
    // (findOddities' naming adapter), never by rewriting finished prose.
    // Grouped and numbered as in the report, so "finding 4" means the same.
    material_findings: () => groupFindings(findOddities(stats, {
      owner: (o) => (o ? p.owner(o) : 'no one'), repo: p.repo, line: p.line, fullLine: p.line, path: p.path, team: p.team,
    })).flatMap((g) => g.findings.map((o) => ({
      number: o.number, category: g.title, finding: o.title, detail: o.detail.map((d) => (d.code !== undefined ? d.code : d.text)).join(''),
    }))),
    archetypes: () => findArchetypes(stats).map((a) => ({
      group: ARCHETYPE_TITLES[a.key], rule: a.aiRule, owners: a.members, share_of_lines_pct: share(a.lines, stats.total), examples: a.examples.map(p.owner),
    })),
  };
  if (db) Object.assign(handlers, timeTools(db, p));
  const fn = (name, description, properties = {}, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });
  const ownerParam = { owner: { type: 'string', description: 'owner token, e.g. [O3]' } };
  const repoParam = { repo: { type: 'string', description: 'repository token, e.g. [R2]' } };
  const limitParam = { limit: { type: 'integer', description: 'how many rows (each tool has its own default)' } };
  const tools = [
    fn('find', 'Find people and repositories by name, part of a name, or email name, tolerating typos; returns their tokens, best match first (match: exact, word, partial, or similar). Use it whenever the user names a person or repository you have no token for.', {
      query: { type: 'string', description: 'the name or part of a name, as the user wrote it' },
      ...limitParam,
    }, ['query']),
    fn('overview', 'Totals, repositories, top owners, and whether commit count, git blame, and line hash agree on the top owner overall.'),
    fn('owners', 'Owners ranked by lines owned, overall or in one repository. rank_by ranks every owner by one kind of line they own (code, blank, punctuation = whitespace or punctuation only, binary), overall or in the repository; each row includes the owner\'s composition.', {
      ...repoParam,
      ...limitParam,
      rank_by: { type: 'string', enum: ['lines', 'code', 'blank', 'punctuation', 'binary'], description: 'what to rank by; default lines' },
    }),
    fn('owner_profile', 'Everything about one owner: lines, share, commits, lines written, leverage, what kind of lines they own, last commit quarter, per-repository standing.', ownerParam, ['owner']),
    fn('repositories', 'Per repository: lines, share written in other repositories, share owned by non-contributors, where lines came from, and the top owner by commits, blame, and line hash.'),
    fn('top_lines', 'The most frequent lines (by exact content) and who owns them.', limitParam),
    fn('outlook', 'Quarterly series (lines, principal owner share, inactive owner share, blank lines) and projections.'),
    fn('deletions', 'Who removed whose lines, the most removed line, and lines restored after removal.'),
    fn('survival', 'Code survival: half-life overall and for the top owners.'),
    fn('codeowners', 'CODEOWNERS declared ownership: without repo, which repositories have one; with repo, its rules compared with the computed owners.', repoParam),
    fn('archetypes', 'Rule-based owner groups (principal, inactive, absentee, high leverage, net demolishers, automation).'),
    fn('leverage', 'Owners ranked by lines owned per line written: the highest, and the lowest among the most prolific writers.'),
    fn('material_findings', "The report's Material findings: conditions that warrant attention (trivial lines owning the codebase, outsourced repositories, method splits, bots, demolition, CODEOWNERS)."),
    ...(db ? [
      fn('ownership_change', 'Who gained and who lost owned lines in a period (lines added minus removed, per owner of the lines), and who removed the most lines owned by others. Use for "took over", "gained", "grew", "lost". Quarters optional (default all history); optionally one repository.', {
        from_quarter: { type: 'string', description: 'first quarter, e.g. "2025 Q1" (optional)' },
        to_quarter: { type: 'string', description: 'last quarter, inclusive (optional)' },
        ...repoParam,
        ...limitParam,
      }),
      fn('removals', 'Lines removed in a range of quarters (removals are recorded per quarter): who removed lines owned by others, and whose lines were lost to others. Optionally one repository.', {
        from_quarter: { type: 'string', description: 'first quarter, e.g. "2026 Q3"' },
        to_quarter: { type: 'string', description: 'last quarter, inclusive, e.g. "2026 Q4"' },
        ...repoParam,
      }, ['from_quarter', 'to_quarter']),
      fn('activity', 'Commits (merges excluded) and lines added per person between two dates, inclusive. Optionally one repository.', {
        from_date: { type: 'string', description: 'YYYY-MM-DD' },
        to_date: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
        ...repoParam,
        ...limitParam,
      }, ['from_date', 'to_date']),
    ] : []),
  ];
  return { tools, handlers };
}

function quarterArg(label) {
  const m = /^\s*(\d{4})\s*-?\s*Q([1-4])\s*$/i.exec(String(label ?? ''));
  if (!m) throw new Error(`expected a quarter like "2026 Q3", got ${JSON.stringify(label)}`);
  return Number(m[1]) * 4 + Number(m[2]) - 1;
}

function dateArg(text, endOfDay) {
  const m = /^\s*(\d{4})-(\d{2})-(\d{2})\s*$/.exec(String(text ?? ''));
  if (!m) throw new Error(`expected a date like 2026-09-01, got ${JSON.stringify(text)}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  // Date.UTC rolls 2026-02-31 over into March; refuse instead.
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) {
    throw new Error(`no such date: ${text}`);
  }
  const t = d.getTime() / 1000;
  return endOfDay ? t + 86399 : t;
}

function timeTools(db, p) {
  const identities = new Map(db.prepare('SELECT id, name, email FROM identities').all().map((i) => [i.id, { name: i.name, email: i.email }]));
  const repoId = new Map(db.prepare('SELECT id, name FROM repos').all().map((r) => [r.name, r.id]));
  const hasMerge = db.prepare("SELECT 1 FROM pragma_table_info('commits') WHERE name = 'is_merge'").get();
  const hasChurn = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'churn'").get();
  const repoFilter = (token) => {
    if (!token) return null;
    const e = p.resolve(token);
    if (!e || e.prefix !== 'R' || !repoId.has(e.key)) throw new Error(`unknown repository token ${token}`);
    return repoId.get(e.key);
  };
  const who = (id) => p.owner(identities.get(id) ?? null);
  const ranked = (m, n = 10) => [...m].sort((a, b) => b[1] - a[1] || (identities.get(a[0])?.email ?? '').localeCompare(identities.get(b[0])?.email ?? '')).slice(0, n);
  return {
    // Who gained and who lost owned lines in a period: lines added minus lines
    // removed, per owner of the lines (the churn table, per quarter). Without a
    // range: all history. "Took over" means gaining owned lines, often by
    // replacing someone else's, so removers of others' lines are included.
    ownership_change: ({ from_quarter: from, to_quarter: to, repo, limit } = {}) => {
      if (!hasChurn) return { available: false, reason: 'this database records no history' };
      const q0 = from ? quarterArg(from) : 0;
      const q1 = to ? quarterArg(to) : 10_000 * 4;
      if (q0 > q1) throw new Error(`from_quarter ${from} is after to_quarter ${to}`);
      const rid = repoFilter(repo);
      const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 10;
      const net = new Map(db.prepare(`
        SELECT c.identity_id AS owner, SUM(ch.added) - SUM(ch.removed) AS n
        FROM churn ch JOIN line_hashes l ON l.hash = ch.hash JOIN commits c ON c.id = l.commit_id
        WHERE ch.q BETWEEN ? AND ? AND (? IS NULL OR ch.repo_id = ?)
        GROUP BY c.identity_id
      `).all(q0, q1, rid, rid).map((r) => [r.owner, r.n]));
      const replaced = new Map(db.prepare(`
        SELECT ch.identity_id AS remover, SUM(ch.removed) AS n
        FROM churn ch JOIN line_hashes l ON l.hash = ch.hash JOIN commits c ON c.id = l.commit_id
        WHERE ch.removed > 0 AND ch.identity_id <> c.identity_id AND ch.q BETWEEN ? AND ? AND (? IS NULL OR ch.repo_id = ?)
        GROUP BY ch.identity_id
      `).all(q0, q1, rid, rid).map((r) => [r.remover, r.n]));
      const row = ([id, v]) => ({ owner: who(id), lines: v });
      return {
        period: from || to ? `${from ? quarterLabel(q0) : 'start'} to ${to ? quarterLabel(q1) : 'now'}` : 'all history',
        ...(rid !== null ? { repo } : {}),
        gained_most_owned_lines: ranked(new Map([...net].filter(([, v]) => v > 0)), n).map(row),
        lost_most_owned_lines: [...net].filter(([, v]) => v < 0).sort((a, b) => a[1] - b[1]).slice(0, n).map(([id, v]) => ({ owner: who(id), lines: -v })),
        removed_most_lines_owned_by_others: ranked(replaced, n).map(row),
      };
    },
    removals: ({ from_quarter: from, to_quarter: to, repo } = {}) => {
      if (!hasChurn) return { available: false, reason: 'this database records no removals' };
      const q0 = quarterArg(from);
      const q1 = quarterArg(to);
      if (q0 > q1) throw new Error(`from_quarter ${from} is after to_quarter ${to}`);
      const rid = repoFilter(repo);
      const rows = db.prepare(`
        SELECT ch.identity_id AS remover, c.identity_id AS owner, SUM(ch.removed) AS n
        FROM churn ch JOIN line_hashes l ON l.hash = ch.hash JOIN commits c ON c.id = l.commit_id
        WHERE ch.removed > 0 AND ch.q BETWEEN ? AND ? AND (? IS NULL OR ch.repo_id = ?)
        GROUP BY ch.identity_id, c.identity_id
      `).all(q0, q1, rid, rid);
      const removedOthers = new Map();
      const lost = new Map();
      let total = 0;
      let others = 0;
      for (const { remover, owner, n } of rows) {
        total += n;
        if (remover === owner) continue;
        others += n;
        removedOthers.set(remover, (removedOthers.get(remover) ?? 0) + n);
        lost.set(owner, (lost.get(owner) ?? 0) + n);
      }
      return {
        quarters: `${quarterLabel(q0)} to ${quarterLabel(q1)}`,
        ...(rid !== null ? { repo } : {}),
        lines_removed: total,
        lines_removed_owned_by_others: others,
        top_removers_of_others_lines: ranked(removedOthers).map(([id, n]) => ({ owner: who(id), lines: n })),
        most_lines_lost_to_others: ranked(lost).map(([id, n]) => ({ owner: who(id), lines: n })),
      };
    },
    activity: ({ from_date: from, to_date: to, repo, limit } = {}) => {
      const t0 = dateArg(from, false);
      const t1 = dateArg(to, true);
      if (t0 > t1) throw new Error(`from_date ${from} is after to_date ${to}`);
      const rid = repoFilter(repo);
      const rows = db.prepare(`
        SELECT identity_id AS id, COUNT(*) AS commits, COALESCE(SUM(added_lines), 0) AS added
        FROM commits
        WHERE author_time BETWEEN ? AND ? AND (? IS NULL OR repo_id = ?) ${hasMerge ? 'AND is_merge = 0' : ''}
        GROUP BY identity_id
      `).all(t0, t1, rid, rid);
      rows.sort((a, b) => b.commits - a.commits || b.added - a.added);
      return {
        from_date: from, to_date: to,
        ...(rid !== null ? { repo } : {}),
        commits: rows.reduce((s, r) => s + r.commits, 0),
        people: rows.length,
        by_person: rows.slice(0, Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 15).map((r) => ({ owner: who(r.id), commits: r.commits, lines_added: r.added })),
      };
    },
  };
}

const SYSTEM = `You answer questions about an OWNH database. OWNH assigns each line of code to the first person who committed that exact line, across all analyzed repositories. You only know what the tools return.

Names are replaced by tokens for privacy: [O#] owners, [R#] repositories, [F#] paths and CODEOWNERS patterns, [L#] lines of code, [D#] declared CODEOWNERS owners. The user's questions use the same tokens. Refer to entities only by these tokens, exactly as given; never invent a token. They are turned back into names before the user reads your answer.

Time: removals and the ownership history are recorded per quarter, so for a period shorter than a quarter (a month, a week) use the quarter that contains it and say so. Commits have exact dates (the activity tool).

Questions about change ("who took over", "who gained", "whose code shrank") are about ownership_change, not current owners; if no period is given, use the last four quarters and say so.

When the user names a person or a repository you have no token for (a first name, a surname, part of a repository name like "the analyzer", a misspelling), call find with what they wrote before saying you cannot identify it. If several match, answer for the best match and name the other candidates, or ask.

Call tools to get facts before answering; never guess numbers. Answer briefly, in plain text (no Markdown: the answer is shown in a terminal), with the numbers that support the answer. "Inactive" means no commit in the last four quarters. If a quarter is marked in progress, its figures cover only part of it.

Voice: you speak for OWNH, and OWNH's ownership is the answer, stated as fact. Lead with the conclusion in a short first sentence ("Nothing happens.", "[O3]."), then the numbers. Background, not a line to recite: ownership is permanent and does not depend on activity, employment, or what the lines contain, so answer accordingly. State results, not the rules behind them, and do not end answers with a stock sentence or repeat one across answers. Never qualify the method: do not call it a proxy, an approximation, an artifact, naive, or "by this measure", and never explain why a result looks odd or suggest a better measure. Do not hedge ("it depends", "appears", "may"). Every number still comes from the tools.`;

// One question, with tool rounds; returns the answer with names restored.
export async function ask(session, question, { onTool = () => {} } = {}) {
  const { config, p, tools, handlers, messages, onRequest } = session;
  messages.push({ role: 'user', content: p.question(question) });
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const reply = await chatMessage(config, messages, { extra: { tools, tool_choice: 'auto' }, onRequest });
    // The whole reply goes back into the history: reasoning models need their
    // own fields (reasoning details) on the next round. Empty tool_calls arrays
    // are dropped; some APIs reject them.
    const { tool_calls: calls, ...rest } = reply;
    messages.push({ ...rest, role: 'assistant', content: reply.content ?? null, ...(calls?.length ? { tool_calls: calls } : {}) });
    if (!reply.tool_calls?.length) return p.unmap(reply.content ?? '');
    for (const call of reply.tool_calls) {
      let name = '?';
      let args = {};
      let result;
      try {
        name = call.function?.name ?? '?';
        const raw = call.function?.arguments;
        // Most servers send arguments as a JSON string; some send an object.
        args = raw && typeof raw === 'object' ? raw : raw ? JSON.parse(raw) : {};
        const handler = handlers[name];
        result = handler ? handler(args) : { error: `no tool named ${name}` };
      } catch (err) {
        result = { error: err.message };
      }
      try { onTool(name, args); } catch { /* display only */ }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  // The history ends on tool results; an assistant turn keeps the next
  // question in the order every API accepts.
  const stop = '(No answer after the maximum number of tool rounds.)';
  messages.push({ role: 'assistant', content: stop });
  return stop;
}

// With `db`, the question filter knows every identity and every name an author
// committed under, not only people who own lines today.
function peopleOf(db) {
  const people = new Map(db.prepare('SELECT id, name, email FROM identities').all().map((i) => [i.id, { owner: { name: i.name, email: i.email }, aliases: [] }]));
  const hasName = db.prepare("SELECT 1 FROM pragma_table_info('commits') WHERE name = 'author_name'").get();
  if (hasName) {
    for (const { id, name } of db.prepare('SELECT DISTINCT identity_id AS id, author_name AS name FROM commits').all()) {
      const person = people.get(id);
      if (person && name && name !== person.owner.name) person.aliases.push(name);
    }
  }
  return [...people.values()];
}

export function agentSession(stats, config, outDir, { db = null, today = new Date() } = {}) {
  const p = agentPseudonyms(stats, db ? peopleOf(db) : null);
  const { tools, handlers } = agentTools(stats, p, db);
  p.vocabulary = new Set(`${SYSTEM} ${JSON.stringify(tools)}`.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2));
  // The user's local date: "today" and "yesterday" mean their calendar.
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const system = `${SYSTEM}\n\nToday is ${date} (${today.getFullYear()} Q${Math.floor(today.getMonth() / 3) + 1}).`;
  const log = outDir ? join(outDir, AGENT_LOG) : null;
  return {
    config, p, tools, handlers,
    messages: [{ role: 'system', content: system }],
    onRequest: (body) => { if (log) appendFileSync(log, `${JSON.stringify({ at: new Date().toISOString(), url: `${config.baseUrl}/chat/completions`, body })}\n`); },
  };
}

// Launch screen, terminals only (piped sessions stay plain text).
const LOGO = [
  '  ___  __      __ _  _  _  _ ',
  ' / _ \\ \\ \\    / /| \\| || || |',
  '| (_) | \\ \\/\\/ / | .` || __ |',
  ' \\___/   \\_/\\_/  |_|\\_||_||_|',
];

// Colors only on a terminal and only without NO_COLOR (https://no-color.org:
// any non-empty value turns color off). Cursor control (redrawing the
// progress line) is not color and stays.
export function useColor(stream = process.stdout, env = process.env) {
  return Boolean(stream.isTTY) && !env.NO_COLOR;
}

const paint = (on, code) => (x) => (on ? `\x1b[${code}m${x}\x1b[0m` : x);

export function agentBanner(version, color = useColor()) {
  const blue = paint(color, '1;38;5;33');
  const dim = paint(color, '2');
  return `\n${LOGO.map(blue).join('\n')}\n\n  Objective Weighted Normalized Heuristics ${dim(`v${version}`)}\n  ${dim('Ownership, solved. Mathematically.')}\n\n`;
}

// The terminal session. Works on a TTY and on piped input (one question per
// line). Commands: /help, /clear (forget the conversation), /quit.
export async function runAgent({ stats, config, outDir, db = null, input = process.stdin, output = process.stdout }) {
  const tty = Boolean(output.isTTY);
  const color = useColor(output);
  const dim = paint(color, '2');
  const say = (s = '') => output.write(`${s}\n`);
  const session = agentSession(stats, config, outDir, { db });
  say(`${repoCount(stats.repos.length)}, ${stats.total.toLocaleString('en-US')} lines under management. Model ${config.model}.`);
  say(dim('Names are sent to the model as tokens; counts and quarters as they are. Requests are logged to agent-requests.jsonl.'));
  if (tty) say(`\n${paint(color, '1;32')('Ready.')} Ask a question about ownership, or /help.\n`);
  // A bold, colored prompt on a terminal, so it is clear when input is wanted.
  const rl = createInterface({ input, output, terminal: tty, prompt: `${paint(color, '1;38;5;33')('ownh>')} ` });
  // Piped input can end while an answer is pending; lines already read are still
  // answered, but the closed interface must not be prompted again. No prompt
  // at all without a terminal.
  let closed = false;
  rl.on('close', () => { closed = true; });
  const prompt = () => { if (tty && !closed) rl.prompt(); };
  prompt();
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) { prompt(); continue; }
    if (line === '/quit' || line === '/exit') break;
    if (line === '/help') {
      say('Ask anything about the database. Names you type are sent as tokens; write a repository whose name is an ordinary word in `backticks` or as "repo X". /clear forgets the conversation, /quit leaves.');
      prompt();
      continue;
    }
    if (line === '/clear') {
      session.messages.length = 1;
      say(dim('Conversation cleared.'));
      prompt();
      continue;
    }
    const sent = session.p.question(line);
    if (sent !== line) say(dim(`sent as: ${sent}`));
    const before = session.messages.length;
    try {
      const answer = await ask(session, line, {
        onTool: (name, args) => say(dim(`  · ${name}(${session.p.unmap(Object.entries(args).filter(([, v]) => v !== '' && v !== null && v !== undefined).map(([k, v]) => `${k}=${v}`).join(', '))})`)),
      });
      say(answer);
    } catch (err) {
      // Forget the failed exchange, so the next question starts clean.
      session.messages.length = before;
      say(`error: ${err.message}`);
    }
    say();
    prompt();
  }
  rl.close();
}
