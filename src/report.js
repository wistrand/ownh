import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { openDb } from './db.js';
import { crossOwnershipSvg, lineSharePieSvg, radarSvg } from './charts.js';
import { reportHtml } from './html.js';
import { findOddities } from './oddities.js';
import { ownerProfile, repoProfile } from './profiles.js';
import { kpiQuarter, outlookCharts, outlookNote, outlookStatements } from './outlook.js';
import { quarterOf } from './timeline.js';
import { aiConfig, aiInsights } from './ai.js';
import { ARCHETYPE_TITLES, exampleLabels, findArchetypes } from './archetypes.js';
import { DECLARED_NOTE, DECLARED_ROWS, DEMOLITION_NOTE, SURVIVAL_NOTE, declaredDetailed, declaredOwners, declaredRepos, declaredSimple, declaredSummary, leverage, survivalStatements, survivalSvg } from './sections.js';
import { stageCache } from './stagecache.js';
import { collectStats, lineLabel, methodShare, ownerLabel, padText, pct, share, textWidth } from './stats.js';

// Writes the report files into outDir. Everything is derived from the .db via
// collectStats; regenerate rather than edit.
// `ai`: also write AI prose (summary, OKR draft, archetype names); see ai.js.
// `aiDryRun`: write the AI request to ai-request.json without sending it.
// `aiCacheOnly`: use cached AI text only, never send a request.
// `complete` replaces the API call (tests).
// `cache`: reuse cached collectStats stages from outDir/stats-cache.json (see cachedStats).
export async function report({ dbPath, outDir, top = 20, log = () => {}, ai = false, aiDryRun = false, aiCacheOnly = false, aiEnv = process.env, complete, cache = true }) {
  mkdirSync(outDir, { recursive: true });
  const stats = cachedStats({ dbPath, outDir, top, log, cache });
  stats.oddities = findOddities(stats);
  const when = generationTime();
  stats.generated = generatedInfo(dbPath, when);
  // "Now" is the newest commit's quarter; if the report is generated inside that
  // quarter, its figures cover only part of it.
  if (stats.timeline) stats.timeline.inProgress = quarterOf(when.getTime() / 1000) === stats.timeline.now;
  stats.archetypes = findArchetypes(stats);
  if (ai || aiDryRun) {
    stats.ai = await aiInsights(stats, stats.archetypes, {
      config: aiConfig(aiEnv), outDir, log, dryRun: aiDryRun, cacheOnly: aiCacheOnly, ...(complete ? { complete } : {}),
    });
    if (stats.ai.withheld) log(`ai: withheld: ${stats.ai.withheld}`);
  }
  const charts = {
    pie: lineSharePieSvg(stats),
    heatmap: crossOwnershipSvg(stats),
    owners: radarSvg(ownerProfile(stats)),
    repos: radarSvg(repoProfile(stats)),
    ...outlookCharts(stats.timeline),
    survival: survivalSvg(stats),
  };
  const files = {
    'report.html': reportHtml(stats, top, charts),
    'leaderboard.md': leaderboard(stats, top, charts),
    'report.json': `${JSON.stringify(stats, null, 2)}\n`,
    'owners.csv': ownersCsv(stats),
    'lines.csv': linesCsv(stats),
    'cross-ownership.csv': crossCsv(stats),
    'methods.csv': methodsCsv(stats),
    ...(declaredRepos(stats).length ? { 'codeowners.csv': codeownersCsv(stats) } : {}),
    'ownership-by-line-hash.svg': charts.pie,
    'cross-ownership.svg': charts.heatmap,
    'owner-profile.svg': charts.owners,
    'repo-profile.svg': charts.repos,
    ...(charts.shares ? { 'ownership-outlook.svg': charts.shares } : {}),
    ...(charts.blank ? { 'blank-line-outlook.svg': charts.blank } : {}),
    ...(charts.survival ? { 'code-survival.svg': charts.survival } : {}),
  };
  for (const [name, content] of Object.entries(files)) writeFileSync(join(outDir, name), content);
  return Object.keys(files);
}

// collectStats is nearly all of a report's run time; everything after it is
// rendering. Its expensive stages are cached in outDir/stats-cache.json, each
// under its own key (see stagecache.js and stats.js), so a code or data change
// recomputes only the stages it affects. With `cache` false nothing is read or
// written.
const STATS_CACHE = 'stats-cache.json';

function cachedStats({ dbPath, outDir, top, log, cache }) {
  const stages = stageCache(cache ? join(outDir, STATS_CACHE) : null, log);
  const db = openDb(dbPath);
  let stats;
  try {
    stats = collectStats(db, { topLines: top, log, cache: stages });
  } finally {
    db.close();
  }
  stages.save();
  // Round-trip through JSON so the rendered stats are plain data, as before.
  return JSON.parse(JSON.stringify(stats));
}

function leaderboard(stats, top, charts) {
  const out = [
    '# OWNH Ownership Report',
    '',
    `Repositories: ${stats.repos.length}. Lines under management: ${stats.total.toLocaleString('en-US')}.`,
    `OWNH ${stats.toolVersion}.`,
    `Database: ${codeSpan(stats.generated.database)}. Generated ${stats.generated.at}.`,
    '',
    ...aiSummaryMd(stats),
    '## Principal owners',
    '',
    ...mdTable(['Rank', 'Owner', 'Lines', 'Share'], stats.owners.slice(0, top).map((o, k) => [
      String(k + 1), md(ownerLabel(o.owner)), num(o.lines), pct(o.lines, stats.total),
    ]), ['r', 'l', 'r', 'r']),
    '',
    '## Ownership profiles',
    '',
    '![Ownership profile: principal owners](owner-profile.svg)',
    '',
    '![Governance profile: largest repositories](repo-profile.svg)',
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
      l.owner ? md(l.owner.name) : '',
      md(l.origin ?? ''),
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
          md(r.name),
          num(r.lines),
          pct(r.foreign, r.lines),
          pct(r.absentee, r.lines),
          outside ? `${md(outside.repo)} (${pct(outside.lines, r.lines)})` : '',
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
    'Blame shows "-" until `bin/ownh.js blame` has covered every file (or every file of its sample).',
    'Values marked ~ are estimates from a random sample of files, with a 95% margin in percentage points.',
    '',
    ...mdTable(['Repository', 'By commits', 'By blame', 'By line hash', 'Agree'], [
      methodCells('**All repositories**', stats.methods),
      ...stats.repos.map((r) => methodCells(md(r.name), r.methods)),
    ], ['l', 'l', 'l', 'l', 'l']),
    '',
    `The three methods agree on ${stats.repos.filter((r) => r.methods.agree).length} of ${stats.repos.length} repositories.`,
    '',
    ...declaredMd(stats),
    ...leverageMd(stats),
    ...demolitionMd(stats),
    ...survivalMd(stats, charts),
    ...outlookMd(stats, charts),
    ...okrMd(stats),
    ...archetypesMd(stats),
    '## Oddities',
    '',
    ...(stats.oddities.length
      ? stats.oddities.map((o) => `- ${md(o.title)}. ${o.detail.map((p) => (p.code !== undefined ? codeSpan(p.code) : md(p.text))).join('')}`)
      : ['None found.']),
    '',
    '## Repositories',
  ];
  for (const r of stats.repos) {
    out.push(
      '',
      `### ${md(r.name)}`,
      '',
      ...mdTable(['Rank', 'Owner', 'Lines', 'Share', 'Commits here'], r.owners.slice(0, top).map((o, k) => [
        String(k + 1),
        md(ownerLabel(o.owner)),
        num(o.lines),
        pct(o.lines, r.lines),
        o.owner === null ? '' : o.contributor ? 'yes' : 'none',
      ]), ['r', 'l', 'r', 'r', 'l']),
    );
  }
  out.push(
    '',
    '## Excluded patterns',
    '',
    stats.excludes.length
      ? `Files matching these patterns were left out of history and the current tree: ${stats.excludes.map(codeSpan).join(', ')}.`
      : 'None. Every file was analyzed.',
  );
  return `${out.join('\n')}\n`;
}

// Which database a report came from, and when it was generated. SOURCE_DATE_EPOCH
// (the reproducible-builds convention, in seconds) overrides the clock.
function generationTime() {
  const epoch = process.env.SOURCE_DATE_EPOCH;
  return epoch && /^\d+$/.test(epoch) ? new Date(Number(epoch) * 1000) : new Date();
}

function generatedInfo(dbPath, when) {
  return { database: basename(dbPath), at: `${when.toISOString().slice(0, 16).replace('T', ' ')} UTC` };
}

const AI_LABEL = (ai) => `Written by AI (${ai.model}) from OWNH's figures; every number was checked against the data. Names were replaced with tokens before anything left this machine.`;

function aiSummaryMd(stats) {
  const ai = stats.ai;
  if (!ai) return [];
  if (ai.withheld) return ['## AI insights (AI-generated)', '', `Withheld: ${md(ai.withheld)}.`, ''];
  return ['## AI insights (AI-generated)', '', ...ai.summary.flatMap((p) => [md(p), '']), `_${AI_LABEL(ai)}_`, ''];
}

function okrMd(stats) {
  const ai = stats.ai;
  if (!ai || ai.withheld) return [];
  return [
    '## OKR draft (AI-generated)',
    '',
    `**Objective:** ${md(ai.okr.objective)}`,
    '',
    ...ai.okr.keyResults.map((k, i) => `- **KR${i + 1}** (${k.status}): ${md(k.text)}`),
    '',
    `_${AI_LABEL(ai)}_`,
    '',
  ];
}

function archetypesMd(stats) {
  if (!stats.archetypes?.length) return [];
  const names = stats.ai?.archetypeNames ?? {};
  return [
    '## Ownership archetypes',
    '',
    ...mdTable(['Archetype', 'Rule', 'Owners', 'Share of lines', 'Examples'], stats.archetypes.map((a) => [
      // AI-written names carry an "(AI)" marker; Markdown has no icon.
      md(names[a.key] ? `${names[a.key]} (AI)` : ARCHETYPE_TITLES[a.key]),
      md(a.rule),
      num(a.members),
      pct(a.lines, stats.total),
      md(exampleLabels(a.examples).join(', ')),
    ]), ['l', 'l', 'r', 'r', 'l']),
    '',
    ...(stats.ai && !stats.ai.withheld ? ['_Archetype names written by AI; membership is computed by OWNH._', ''] : []),
  ];
}

function declaredMd(stats) {
  const repos = declaredRepos(stats);
  if (!repos.length) return [];
  const top = (t) => (t ? `${md(t.owner.name)} (${pct(t.count, t.total)})` : '-');
  const header = ['Pattern', 'Declared owners', 'Lines', 'By line hash', 'By blame'];
  const rowsOf = (r) => r.declared.rules.slice(0, DECLARED_ROWS).map((rule) => [
    code(rule.pattern),
    md(declaredOwners(rule)),
    num(rule.lines),
    top(rule.hash),
    top(rule.blame),
  ]);
  const detailed = declaredDetailed(stats);
  const simple = declaredSimple(stats);
  // One set of column widths for every repository's table.
  const widths = header.map((h, c) => Math.max(textWidth(h), ...detailed.flatMap((r) => rowsOf(r).map((row) => textWidth(row[c])))));
  return [
    '## Declared ownership',
    '',
    'What CODEOWNERS declares, next to the top owner of the same lines by line hash and by `git blame`.',
    '',
    ...detailed.flatMap((r) => [
      `### ${md(r.name)}`,
      '',
      md(declaredSummary(r)),
      '',
      ...mdTable(header, rowsOf(r), ['l', 'l', 'r', 'l', 'l'], widths),
      '',
    ]),
    ...(simple.length ? [
      `### ${detailed.length ? 'Other repositories' : 'Repositories'} with a single rule`,
      '',
      'One rule decides every file in these repositories (usually a catch-all).',
      '',
      ...mdTable(['Repository', ...header], simple.map((r) => {
        const rule = r.declared.rules[0];
        return rule
          ? [md(r.name), code(rule.pattern), md(declaredOwners(rule)), num(rule.lines), top(rule.hash), top(rule.blame)]
          : [md(r.name), '-', '(no rule matches a file)', num(r.declared.noRule), '-', '-'];
      }), ['l', 'l', 'l', 'r', 'l', 'l']),
      '',
    ] : []),
    DECLARED_NOTE,
    '',
  ];
}

function codeownersCsv(stats) {
  const cols = (t) => (t ? [t.owner.name, t.owner.email, t.count, t.share] : ['', '', '', '']);
  return csv(
    ['repo', 'file', 'pattern', 'rule_line', 'declared_owners', 'lines', 'hash_name', 'hash_email', 'hash_count', 'hash_share', 'blame_name', 'blame_email', 'blame_count', 'blame_share'],
    declaredRepos(stats).flatMap((r) => r.declared.rules.map((rule) => [
      r.name, r.declared.file, rule.pattern, rule.line, rule.owners.join(' '), rule.lines, ...cols(rule.hash), ...cols(rule.blame),
    ])),
  );
}

function leverageMd(stats) {
  const lev = leverage(stats);
  if (!lev) return [];
  const rows = (list) => list.map((r) => [md(ownerLabel(r.owner)), num(r.written), num(r.owned), ratio(r.ratio)]);
  const head = ['Owner', 'Lines written', 'Lines owned', 'Owned per line written'];
  return [
    '## Leverage',
    '',
    'Lines owned today for every line written. Identical lines are owned by whoever wrote them first, so one',
    'line written can be many lines owned.',
    '',
    '### Highest leverage',
    '',
    ...mdTable(head, rows(lev.highest), ['l', 'r', 'r', 'r']),
    '',
    '### Lowest retention among the most prolific writers',
    '',
    ...mdTable(head, rows(lev.lowest), ['l', 'r', 'r', 'r']),
    '',
  ];
}

function demolitionMd(stats) {
  const d = stats.deletions;
  if (!d) return [];
  const head = (label) => ['Rank', label, 'Lines', 'Own lines removed'];
  const rows = (list) => list.map((r, k) => [String(k + 1), md(ownerLabel(r.owner)), num(r.lines), num(r.ownRemoved)]);
  return [
    '## Code demolition',
    '',
    `${num(d.added)} lines added and ${num(d.removed)} removed in total; ${num(d.removedOfOthers)} of the removed lines (${pct(d.removedOfOthers, d.removed)}) belonged to someone other than the person removing them.`,
    '',
    '### Most lines removed that belonged to others',
    '',
    ...mdTable(head('Remover'), rows(d.topRemovers), ['r', 'l', 'r', 'r']),
    '',
    '### Most lines lost to others',
    '',
    ...mdTable(head('Owner'), rows(d.mostRemovedOwners), ['r', 'l', 'r', 'r']),
    '',
    DEMOLITION_NOTE,
    '',
  ];
}

function survivalMd(stats, charts) {
  if (!stats.survival) return [];
  return [
    '## Code survival',
    '',
    ...survivalStatements(stats).map((s) => `- ${md(s)}`),
    '',
    ...(charts.survival ? ['![Code survival](code-survival.svg)', ''] : []),
    SURVIVAL_NOTE,
    '',
  ];
}

function ratio(r) {
  return r >= 10 ? num(Math.round(r)) : r.toFixed(2);
}

function outlookMd(stats, charts) {
  const t = stats.timeline;
  if (!t) return [];
  const pctOrDash = (v) => (v === null ? '-' : `${(v * 100).toFixed(1)}%`);
  const signed = (v) => (v === null ? '-' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`);
  return [
    '## Outlook',
    '',
    ...outlookStatements(t).map((s) => `- **${s.label}:** ${md(s.text)}`),
    '',
    ...(charts.shares ? ['![Ownership outlook](ownership-outlook.svg)', ''] : []),
    ...(charts.blank ? ['![Blank line outlook](blank-line-outlook.svg)', ''] : []),
    ...mdTable(
      ['Quarter', 'Lines under management', 'QoQ', 'New owners', t.principal ? md(t.principal.name) : 'Principal owner', 'Non-contributors', 'Inactive owners', 'Blank lines committed'],
      t.kpis.map((k) => [kpiQuarter(t, k), num(k.lines), signed(k.linesChange), num(k.newOwners), pctOrDash(k.principalShare), pctOrDash(k.nonContributorShare), pctOrDash(k.inactiveShare), k.blank === null ? '-' : num(k.blank)]),
      ['l', 'r', 'r', 'r', 'r', 'r', 'r', 'r'],
    ),
    '',
    md(outlookNote(t)),
    '',
  ];
}

function methodCells(name, m) {
  const cell = (t) => (t ? `${md(t.owner.name)} (${methodShare(t)})` : '-');
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
// `minWidths` pads columns to at least those widths, so related tables line up.
function mdTable(header, rows, align, minWidths = []) {
  const all = [header, ...rows];
  const widths = header.map((_, c) => Math.max(3, minWidths[c] ?? 0, ...all.map((r) => textWidth(r[c]))));
  const pad = (s, c) => padText(s, widths[c], align[c] === 'r');
  const line = (r) => `| ${r.map(pad).join(' | ')} |`;
  const rule = `|${widths.map((w, c) => (align[c] === 'r' ? `${'-'.repeat(w + 1)}:` : `${'-'.repeat(w + 2)}`)).join('|')}|`;
  return [line(header), rule, ...rows.map(line)];
}

// A code span for a table cell.
function code(s) {
  return escapeCell(codeSpan(s));
}

// A code span for prose. The fence is one backtick longer than the longest run
// of backticks in the text, so no run inside can close it early.
function codeSpan(s) {
  const longest = Math.max(0, ...(s.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = s.startsWith('`') || s.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${s}${pad}${fence}`;
}

// Pipes only: for code spans in table cells, where other escapes would show.
function escapeCell(s) {
  return s.replace(/\|/g, '\\|');
}

// Untrusted text (author names, repository names, line text in prose, AI text)
// as literal Markdown: inline markup and HTML characters are escaped, and a
// leading block marker ("# ", "- ", "1. ") cannot start a heading or list.
function md(s) {
  return String(s)
    .replace(/[\\`*_[\]<>|~&]/g, '\\$&')
    .replace(/^(\s*)(#|[-+])(?=\s|$)/, '$1\\$2')
    .replace(/^(\s*\d+)([.)])(?=\s|$)/, '$1\\$2');
}

function num(n) {
  return n.toLocaleString('en-US');
}
