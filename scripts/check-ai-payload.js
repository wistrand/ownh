#!/usr/bin/env node
// Checks an AI request written by `ownh report --ai-dry-run` for anything that
// must not leave the machine: committer names and emails, repository names,
// and years. Exits 1 when it finds one, so it can gate the real --ai run:
//
//   ownh report --db x.db --ai-dry-run && node scripts/check-ai-payload.js x.db && ownh report --db x.db --ai
//
// Usage: node scripts/check-ai-payload.js <db> [ai-request.json]
// (default request: report/<db name>/ai-request.json)
//
// Only the non-system messages are checked: the system prompt is fixed text
// in src/ai.js and carries no data. In them, emails and names of more than one
// word are looked for anywhere, as whole words in any case. One-word names and
// repository names ("may", "text", "two" are all real committers or repos) are
// flagged only when they are a whole JSON string value, since the fixed
// vocabulary ("ten to two dozen") contains ordinary words. Names of one or two
// letters are skipped. Years are looked for anywhere.
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const [dbPath, requestPath = join('report', basename(dbPath ?? '').replace(/\.db$/, ''), 'ai-request.json')] = process.argv.slice(2);
if (!dbPath) {
  process.stderr.write('usage: node scripts/check-ai-payload.js <db> [ai-request.json]\n');
  process.exit(2);
}
const request = JSON.parse(readFileSync(requestPath, 'utf8'));
const messages = (request.body ?? request).messages.filter((m) => m.role !== 'system');
const text = messages.map((m) => m.content).join('\n');
// Every string value of the JSON objects embedded in the messages.
const values = new Set();
const collect = (x) => {
  if (typeof x === 'string') values.add(x.trim().toLowerCase());
  else if (x && typeof x === 'object') Object.values(x).forEach(collect);
};
for (const m of messages) {
  const start = m.content.indexOf('{');
  const end = m.content.lastIndexOf('}');
  if (start < 0 || end < start) continue;
  try {
    collect(JSON.parse(m.content.slice(start, end + 1)));
  } catch {
    // Not JSON: only the anywhere checks apply.
  }
}
const db = new DatabaseSync(dbPath, { readOnly: true });
const words = new Set([
  ...db.prepare('SELECT name, email FROM identities').all().flatMap((i) => [i.name, i.email]),
  ...db.prepare('SELECT name FROM repos').all().map((r) => r.name),
]);
db.close();

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const found = [];
for (const w of words) {
  if (!w || w.trim().length < 3) continue;
  const anywhere = w.includes('@') || /\s/.test(w.trim());
  if (anywhere ? new RegExp(`(?<![\\w@.-])${escape(w)}(?![\\w@-])`, 'i').test(text) : values.has(w.trim().toLowerCase())) found.push(w);
}
const years = [...new Set(text.match(/(?<!\d)(19|20)\d\d(?!\d)/g) ?? [])];

if (found.length || years.length) {
  if (found.length) process.stderr.write(`names in ${requestPath}: ${found.join(', ')}\n`);
  if (years.length) process.stderr.write(`years in ${requestPath}: ${years.join(', ')}\n`);
  process.exit(1);
}
process.stderr.write(`${requestPath}: no names, emails, repository names, or years\n`);
