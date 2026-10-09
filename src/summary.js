import { openDb } from './db.js';
import { collectStats, lineLabel, ownerLabel, pct } from './stats.js';

export function summary({ dbPath, top = 10, log }) {
  const db = openDb(dbPath);
  try {
    return render(collectStats(db, { topLines: top, log }), top);
  } finally {
    db.close();
  }
}

function render(stats, top) {
  const out = [
    'OWNH summary',
    `repos: ${stats.repos.map((r) => r.name).join(', ')}`,
    `excluded patterns: ${stats.excludes.length ? stats.excludes.join(', ') : '(none)'}`,
    `lines scored: ${stats.total}`,
    '',
    'Top owners, all repos',
    ...ownerTable(stats.owners, top, stats.total),
    '',
    'Top lines, all repos',
    ...table(stats.lines.map((l, k) => [
      `${k + 1}.`,
      lineLabel(l),
      String(l.lines),
      pct(l.lines, stats.total),
      l.owner ? `${l.owner.name} (first in ${l.origin})` : '',
    ])),
  ];
  for (const repo of stats.repos) {
    const outside = repo.origins.filter((o) => o.repo !== null && o.repo !== repo.name).slice(0, 3);
    out.push(
      '',
      `Repo ${repo.name}`,
      `lines: ${repo.lines}, owned through lines first written in another repo: ${repo.foreign} (${pct(repo.foreign, repo.lines)})`,
      `owned by people with no commits here: ${repo.absentee} (${pct(repo.absentee, repo.lines)})`,
      `largest outside sources: ${outside.length ? outside.map((o) => `${o.repo} ${pct(o.lines, repo.lines)}`).join(', ') : '(none)'}`,
      ...ownerTable(repo.owners, top, repo.lines),
    );
  }
  return out.join('\n') + '\n';
}

function ownerTable(owners, top, total) {
  return table(owners.slice(0, top).map((o, k) => [
    `${k + 1}.`,
    ownerLabel(o.owner),
    String(o.lines),
    pct(o.lines, total),
    o.contributor === false && o.owner ? 'no commits here' : '',
  ]));
}

function table(rows) {
  if (rows.length === 0) return ['  (none)'];
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
  return rows.map((r) => '  ' + r.map((cell, c) => cell.padEnd(widths[c])).join('  ').trimEnd());
}
