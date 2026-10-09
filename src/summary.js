import { openDb } from './db.js';
import { collectStats, lineLabel, methodShare, ownerLabel, pct } from './stats.js';

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
  out.push(
    '',
    'Three ways to own: top owner by commits / by git blame / by line hash',
    ...table([
      methodRow('all repos', stats.methods),
      ...stats.repos.map((r) => methodRow(r.name, r.methods)),
    ]),
  );
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

function methodRow(name, m) {
  const cell = (t) => (t ? `${t.owner.name} ${methodShare(t)}` : '-');
  const sampled = m.blame?.estimate?.files ? `blame sampled ${m.blame.estimate.files}/${m.blame.estimate.ofFiles} files` : '';
  return [name, cell(m.commits), cell(m.blame), cell(m.hash), m.agree ? 'agree' : 'disagree', sampled];
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
