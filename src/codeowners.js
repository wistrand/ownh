// Declared ownership: the CODEOWNERS file at a repo's stored head, read so the
// report can set what a team declares next to what OWNH computes. OWNH never
// writes or generates CODEOWNERS.
//
// Semantics follow GitHub's documented rules:
//   - the first file found among CODEOWNERS_PATHS is used
//   - one rule per line: a pattern, then owners (@user, @org/team, or an
//     email); "#" starts a comment; a rule with no owners leaves its paths
//     explicitly unowned
//   - the last rule that matches a path wins
//   - patterns are gitignore-like: "*" and "?" stay within one path segment,
//     "**" crosses segments, a leading "/" or a "/" inside anchors the pattern
//     at the repo root, otherwise it matches at any depth; a pattern names a
//     file or a directory, and a directory covers everything below it, except
//     that a final segment with a wildcard ("docs/*") covers only that level
// GitLab section headers ("[Section]") are skipped; GitLab's per-section
// matching is not modeled. "!" negation and "[a-z]" ranges are not CODEOWNERS
// syntax on GitHub and are taken literally.

import { git } from './git.js';
import { topOf } from './rank.js';

export const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS', '.gitlab/CODEOWNERS'];

// The CODEOWNERS file at `head`, as { path, text }, or null when the repo has
// none or is no longer readable (the .db outlives its clones).
export function readCodeowners(repoPath, head) {
  for (const path of CODEOWNERS_PATHS) {
    try {
      return { path, text: git(repoPath, ['show', `${head}:${path}`]) };
    } catch {
      // Not at this location (or the repo is gone): try the next one.
    }
  }
  return null;
}

// Declared ownership for one repo: every line at head resolved to the rule that
// covers its file, and per rule the declared owners next to the top owner by
// line hash and, when `blameFull`, by blame (ranked with topOf over
// `identities`, a Map of id -> { name, email }). Returns null without a
// CODEOWNERS file.
export function declaredOwnership(db, repo, { blameFull, identities }) {
  const top = (counts, n) => topOf(counts, identities, n);
  const file = readCodeowners(repo.path, repo.head);
  if (!file) return null;
  const rules = parseCodeowners(file.text);
  const rows = db.prepare(`
    SELECT h.path AS path, c.identity_id AS owner, h.blame_identity_id AS blamer, COUNT(*) AS n
    FROM head_lines h
    LEFT JOIN line_hashes l ON l.hash = h.hash
    LEFT JOIN commits c ON c.id = l.commit_id
    WHERE h.repo_id = ?
    GROUP BY h.path, c.identity_id, h.blame_identity_id
  `).iterate(repo.id);
  const ruleOf = new Map(); // path -> rule index, resolved once per path
  const per = rules.map(() => ({ lines: 0, hash: new Map(), blame: new Map() }));
  let total = 0;
  let noRule = 0;
  for (const { path, owner, blamer, n } of rows) {
    let i = ruleOf.get(path);
    if (i === undefined) ruleOf.set(path, (i = ruleFor(rules, path)));
    total += n;
    if (i < 0) {
      noRule += n;
      continue;
    }
    const r = per[i];
    r.lines += n;
    if (owner !== null) r.hash.set(owner, (r.hash.get(owner) ?? 0) + n);
    if (blamer !== null) r.blame.set(blamer, (r.blame.get(blamer) ?? 0) + n);
  }
  let unowned = 0;
  const out = rules.map((rule, i) => {
    const r = per[i];
    if (rule.owners.length === 0) unowned += r.lines;
    return {
      pattern: rule.pattern,
      line: rule.line,
      owners: rule.owners,
      lines: r.lines,
      hash: top(r.hash, r.lines),
      blame: blameFull ? top(r.blame, r.lines) : null,
    };
  });
  return {
    file: file.path,
    lines: total,
    // Lines no rule matches, and lines whose rule names no owner.
    noRule,
    unowned,
    rules: out.filter((r) => r.lines > 0).sort((a, b) => b.lines - a.lines || a.line - b.line),
    // Rules that decide no line, in file order, split by why: `unmatched`
    // patterns match no file at head; `shadowed` ones match files, but a later
    // rule wins for every one of them (last match wins).
    ...idleRules(rules, out, [...ruleOf.keys()]),
  };
}

function idleRules(rules, out, paths) {
  const unmatched = [];
  const shadowed = [];
  out.forEach((r, i) => {
    if (r.lines > 0) return;
    (paths.some((p) => rules[i].regex.test(p)) ? shadowed : unmatched).push(r.pattern);
  });
  return { unmatched, shadowed, unmatchedRules: unmatched.length, shadowedRules: shadowed.length };
}

export function parseCodeowners(text) {
  const rules = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\r$/, '').trim();
    if (!line || line.startsWith('#') || /^\^?\[[^\]]*\]/.test(line)) return;
    // A pattern can contain escaped spaces ("my\ dir/").
    const tokens = line.match(/(?:\\.|[^\s\\])+/g) ?? [];
    const pattern = tokens[0].replace(/\\(.)/g, '$1');
    const owners = [];
    for (const t of tokens.slice(1)) {
      if (t.startsWith('#')) break;
      owners.push(t);
    }
    rules.push({ pattern, owners, line: i + 1, regex: patternRegex(pattern) });
  });
  return rules;
}

// Index of the rule that decides `path` (the last matching one), or -1.
export function ruleFor(rules, path) {
  for (let i = rules.length - 1; i >= 0; i--) if (rules[i].regex.test(path)) return i;
  return -1;
}

export function patternRegex(pattern) {
  let p = pattern;
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.slice(0, -1);
  const anchored = p.startsWith('/') || p.includes('/');
  p = p.replace(/^\/+/, '');
  const last = p.slice(p.lastIndexOf('/') + 1);
  const wildLast = /[*?]/.test(last) && last !== '**';
  let body = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      if (p[i + 2] === '/') {
        body += '(?:.*/)?';
        i += 2;
      } else {
        body += '.*';
        i += 1;
      }
    } else if (c === '*') body += '[^/]*';
    else if (c === '?') body += '[^/]';
    else body += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const prefix = anchored ? '^' : '^(?:.*/)?';
  // A directory covers its contents; "dir/" covers only its contents; a
  // wildcard in the last segment stops at that level.
  const suffix = dirOnly ? '/.*$' : wildLast ? '$' : '(?:/.*)?$';
  return new RegExp(prefix + body + suffix);
}
