#!/usr/bin/env node
// Checks an AI request written by `ownh report --ai-dry-run` for anything that
// must not leave the machine: committer names and emails, repository names,
// and years. Exits 1 when it finds one, so it can gate the real --ai run:
//
//   ownh report --db x.db --ai-dry-run && node scripts/check-ai-payload.js x.db && ownh report --db x.db --ai
//
// Usage: node scripts/check-ai-payload.js <db> [report dir or ai-request.json]
// The default is report/<db name>/. A report written elsewhere (--out,
// --pseudonymize) needs its directory passed. A request file more than an
// hour old is refused, since it is likely from another run.
//
// Only the non-system messages are checked: the system prompt is fixed text
// in src/ai.js and carries no data. Every string value (and key) of the JSON
// in them is decoded and checked:
// - emails and names of more than one word, anywhere, in any case;
// - one-word names and repository names only as a whole value: illustrative
//   committers or repositories called "may", "two", or "text" would match the
//   prompt's and the size bands' ordinary words ("ten to two dozen").
// Names come from the identities and from every name a commit was authored
// under. Names of one or two letters are skipped. Years are looked for
// anywhere.
import { readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MAX_AGE_MS = 60 * 60 * 1000;
const [dbPath, target = join('report', basename(dbPath ?? '').replace(/\.db$/, ''))] = process.argv.slice(2);
if (!dbPath) {
  process.stderr.write('usage: node scripts/check-ai-payload.js <db> [report dir or ai-request.json]\n');
  process.exit(2);
}
const fail = (msg) => {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
};
const requestPath = target.endsWith('.json') ? target : join(target, 'ai-request.json');
const age = Date.now() - statSync(requestPath).mtimeMs;
if (age > MAX_AGE_MS) fail(`${requestPath} is ${Math.round(age / 60000)} minutes old; run --ai-dry-run again, or pass the directory it wrote to`);

const request = JSON.parse(readFileSync(requestPath, 'utf8'));
const messages = (request.body ?? request).messages.filter((m) => m.role !== 'system');
if (messages.some((m) => typeof m.content !== 'string')) fail(`${requestPath}: a message has non-text content; this check cannot read it`);
const text = messages.map((m) => m.content).join('\n');
// Every string value and key of the JSON embedded in the messages, decoded.
const strings = [];
const collect = (x) => {
  if (typeof x === 'string') strings.push(x);
  else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) {
    if (!Array.isArray(x)) strings.push(k);
    collect(v);
  }
};
for (const m of messages) {
  const start = m.content.indexOf('{');
  const end = m.content.lastIndexOf('}');
  if (start < 0 || end < start) continue;
  try {
    collect(JSON.parse(m.content.slice(start, end + 1)));
  } catch {
    // Not JSON: only the raw text is checked.
  }
}
const values = new Set(strings.map((s) => s.trim().toLowerCase()));
const haystacks = [text, ...strings];

const db = new DatabaseSync(dbPath, { readOnly: true });
const words = new Set([
  ...db.prepare('SELECT name, email FROM identities').all().flatMap((i) => [i.name, i.email]),
  ...db.prepare('SELECT DISTINCT author_name AS name FROM commits WHERE author_name IS NOT NULL').all().map((c) => c.name),
  ...db.prepare('SELECT name FROM repos').all().map((r) => r.name),
].filter((w) => typeof w === 'string').map((w) => w.trim()));
db.close();

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const found = [];
for (const w of words) {
  if (w.length < 3) continue;
  const anywhere = w.includes('@') || /\s/.test(w);
  if (anywhere) {
    const re = new RegExp(`(?<![\\w@.-])${escape(w)}(?![\\w@-])`, 'i');
    if (haystacks.some((h) => re.test(h))) found.push(w);
  } else if (values.has(w.toLowerCase())) found.push(w);
}
const years = [...new Set(text.match(/(?<!\d)(19|20)\d\d(?!\d)/g) ?? [])];

if (found.length || years.length) {
  if (found.length) process.stderr.write(`names in ${requestPath}: ${found.slice(0, 20).join(', ')}${found.length > 20 ? `, and ${found.length - 20} more` : ''}\n`);
  if (years.length) process.stderr.write(`years in ${requestPath}: ${years.join(', ')}\n`);
  process.exit(1);
}
process.stderr.write(`${requestPath}: no names, emails, repository names, or years\n`);
