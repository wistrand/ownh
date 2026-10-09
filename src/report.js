import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from './db.js';
import { crossOwnershipSvg, lineSharePieSvg } from './charts.js';
import { reportHtml } from './html.js';
import { collectStats, lineLabel, methodShare, ownerLabel, pct, share } from './stats.js';

// Writes the report files into outDir. Everything is derived from the .db via
// collectStats; regenerate rather than edit.
export function report({ dbPath, outDir, top = 20, log }) {
  const db = openDb(dbPath);
  let stats;
  try {
    stats = collectStats(db, { topLines: top, log });
  } finally {
    db.close();
  }
  mkdirSync(outDir, { recursive: true });
  const charts = { pie: lineSharePieSvg(stats), heatmap: crossOwnershipSvg(stats) };
  const files = {
    'report.html': reportHtml(stats, top, charts),
    'leaderboard.md': leaderboard(stats, top),
    'report.json': `${JSON.stringify(stats, null, 2)}\n`,
    'owners.csv': ownersCsv(stats),
    'lines.csv': linesCsv(stats),
    'cross-ownership.csv': crossCsv(stats),
    'methods.csv': methodsCsv(stats),
    'ownership-by-line-hash.svg': charts.pie,
    'cross-ownership.svg': charts.heatmap,
  };
  for (const [name, content] of Object.entries(files)) writeFileSync(join(outDir, name), content);
  return Object.keys(files);
}

function leaderboard(stats, top) {
  const out = [
    '# OWNH Ownership Report',
    '',
    `Repositories: ${stats.repos.length}. Lines under management: ${stats.total.toLocaleString('en-US')}.`,
    `Excluded patterns: ${stats.excludes.length ? stats.excludes.map(code).join(', ') : 'none'}.`,
    `OWNH ${stats.toolVersion}.`,
    '',
    '## Principal owners',
    '',
    ...mdTable(['Rank', 'Owner', 'Lines', 'Share'], stats.owners.slice(0, top).map((o, k) => [
      String(k + 1), escapeCell(ownerLabel(o.owner)), num(o.lines), pct(o.lines, stats.total),
    ]), ['r', 'l', 'r', 'r']),
    '',
    '## Principal lines',
    '',
    '![Ownership by line hash](ownership-by-line-hash.svg)',
    '',
    ...mdTable(['Rank', 'Line', 'Lines', 'Share', 'Owner', 'First written in'], stats.lines.map((l, k) => [
      String(k + 1),
      l.binary === null ? '(unattributed)' : code(lineLabel(l, 60)),
      num(l.lines),
      pct(l.lines, stats.total),
      l.owner ? escapeCell(l.owner.name) : '',
      l.origin ?? '',
    ]), ['r', 'l', 'r', 'r', 'l', 'l']),
    '',
    '## Cross-repository ownership',
    '',
    'Rows are the repository where a line lives; columns are the repository where',
    'that line was first written, and so where its owner acquired it.',
    '',
    '![Cross-repository ownership](cross-ownership.svg)',
    '',
    ...mdTable(
      ['Repository', 'Lines', 'Owned from other repos', 'Owned by non-contributors', 'Largest outside source'],
      stats.repos.map((r) => {
        const outside = r.origins.find((o) => o.repo !== null && o.repo !== r.name);
        return [
          r.name,
          num(r.lines),
          pct(r.foreign, r.lines),
          pct(r.absentee, r.lines),
          outside ? `${outside.repo} (${pct(outside.lines, r.lines)})` : '',
        ];
      }),
      ['l', 'r', 'r', 'r', 'l'],
    ),
    '',
    'Non-contributors own lines in a repository without a single commit to it.',
    '',
    '## Three ways to own a repository',
    '',
    'The top owner of each repository by commit count, by `git blame`, and by line hash.',
    'Blame shows "-" until `ownh blame` has covered every file (or every file of its sample).',
    'Values marked ~ are estimates from a random sample of files, with a 95% margin in percentage points.',
    '',
    ...mdTable(['Repository', 'By commits', 'By blame', 'By line hash', 'Agree'], [
      methodCells('**All repositories**', stats.methods),
      ...stats.repos.map((r) => methodCells(r.name, r.methods)),
    ], ['l', 'l', 'l', 'l', 'l']),
    '',
    `The three methods agree on ${stats.repos.filter((r) => r.methods.agree).length} of ${stats.repos.length} repositories.`,
    '',
    '## Repositories',
  ];
  for (const r of stats.repos) {
    out.push(
      '',
      `### ${r.name}`,
      '',
      ...mdTable(['Rank', 'Owner', 'Lines', 'Share', 'Commits here'], r.owners.slice(0, top).map((o, k) => [
        String(k + 1),
        escapeCell(ownerLabel(o.owner)),
        num(o.lines),
        pct(o.lines, r.lines),
        o.owner === null ? '' : o.contributor ? 'yes' : 'none',
      ]), ['r', 'l', 'r', 'r', 'l']),
    );
  }
  return `${out.join('\n')}\n`;
}

function methodCells(name, m) {
  const cell = (t) => (t ? `${escapeCell(t.owner.name)} (${methodShare(t)})` : '-');
  return [name, cell(m.commits), cell(m.blame), cell(m.hash), m.agree ? 'yes' : 'no'];
}

function methodsCsv(stats) {
  const cols = (t) => (t ? [t.owner.name, t.owner.email, t.count, t.total, t.share] : ['', '', '', '', '']);
  const est = (t) => (t?.estimate ? [t.estimate.files ?? '', t.estimate.ofFiles ?? '', t.estimate.margin ?? ''] : ['', '', '']);
  const header = ['repo'];
  for (const m of ['commits', 'blame', 'hash']) header.push(`${m}_name`, `${m}_email`, `${m}_count`, `${m}_total`, `${m}_share`);
  header.push('blame_sample_files', 'blame_files', 'blame_margin', 'agree');
  const row = (name, m) => [name, ...cols(m.commits), ...cols(m.blame), ...cols(m.hash), ...est(m.blame), Number(m.agree)];
  return csv(header, [row('', stats.methods), ...stats.repos.map((r) => row(r.name, r.methods))]);
}

function ownersCsv(stats) {
  return csv(['rank', 'name', 'email', 'lines', 'share'], stats.owners.map((o, k) => [
    k + 1, o.owner?.name ?? '', o.owner?.email ?? '', o.lines, share(o.lines, stats.total),
  ]));
}

function linesCsv(stats) {
  return csv(['rank', 'line', 'binary', 'path', 'lines', 'share', 'owner_name', 'owner_email', 'origin_repo'], stats.lines.map((l, k) => [
    k + 1, l.text ?? '', l.binary === null ? '' : Number(l.binary), l.binary ? l.path : '', l.lines,
    share(l.lines, stats.total), l.owner?.name ?? '', l.owner?.email ?? '', l.origin ?? '',
  ]));
}

function crossCsv(stats) {
  return csv(['repo', 'origin_repo', 'lines', 'share_of_repo'], stats.repos.flatMap((r) =>
    r.origins.map((o) => [r.name, o.repo ?? '', o.lines, share(o.lines, r.lines)])));
}

function csv(header, rows) {
  const cell = (v) => {
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `${[header, ...rows].map((r) => r.map(cell).join(',')).join('\n')}\n`;
}

// Markdown table with padded columns; align is 'l' or 'r' per column.
function mdTable(header, rows, align) {
  const all = [header, ...rows];
  const widths = header.map((_, c) => Math.max(3, ...all.map((r) => r[c].length)));
  const pad = (s, c) => (align[c] === 'r' ? s.padStart(widths[c]) : s.padEnd(widths[c]));
  const line = (r) => `| ${r.map(pad).join(' | ')} |`;
  const rule = `|${widths.map((w, c) => (align[c] === 'r' ? `${'-'.repeat(w + 1)}:` : `${'-'.repeat(w + 2)}`)).join('|')}|`;
  return [line(header), rule, ...rows.map(line)];
}

function code(s) {
  const fence = s.includes('`') ? '``' : '`';
  const pad = s.startsWith('`') || s.endsWith('`') ? ' ' : '';
  return escapeCell(`${fence}${pad}${s}${pad}${fence}`);
}

function escapeCell(s) {
  return s.replace(/\|/g, '\\|');
}

function num(n) {
  return n.toLocaleString('en-US');
}
