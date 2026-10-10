// Self-contained HTML version of the report: the same numbers as
// leaderboard.md, with both charts inlined so their <title> tooltips work, and
// sortable tables. No external assets.
//
// The inlined SVGs carry their own <style> with short class names (.title,
// .label, .muted, ...). Page styles use the "r-" prefix so they never collide.
import { outlookNote, outlookStatements } from './outlook.js';
import { DEMOLITION_NOTE, SURVIVAL_NOTE, leverage, survivalStatements } from './sections.js';
import { lineLabel, methodShare, ownerLabel, pct, share } from './stats.js';

export function reportHtml(stats, top, charts) {
  const topOwner = stats.owners.find((o) => o.owner);
  const topLine = stats.lines[0];
  const main = [
    `<header class="r-head">
      <h1>OWNH Ownership Report</h1>
      <p class="r-meta">${stats.repos.length} repositories · ${num(stats.total)} lines under management · OWNH ${esc(stats.toolVersion)}</p>
    </header>`,
    `<section class="r-tiles">
      ${tile('Repositories', num(stats.repos.length))}
      ${tile('Lines under management', num(stats.total))}
      ${topOwner ? tile('Principal owner', esc(topOwner.owner.name), pct(topOwner.lines, stats.total)) : ''}
      ${topLine ? tile('Principal line', `<code class="r-lit">${esc(lineLabel(topLine, 24))}</code>`, pct(topLine.lines, stats.total)) : ''}
    </section>`,
    section('Principal owners', table(
      ['Rank', 'Owner', 'Lines', 'Share'],
      stats.owners.slice(0, top).map((o, k) => [
        cell(k + 1, k + 1), cell(esc(ownerLabel(o.owner))), cell(num(o.lines), o.lines), cell(pct(o.lines, stats.total), o.lines),
      ]),
      ['num', '', 'num', 'num'],
    )),
    section('Ownership profiles', `
      <p class="r-note">Hover a point for the exact value.</p>
      <div class="r-pair"><figure class="r-chart">${charts.owners}</figure><figure class="r-chart">${charts.repos}</figure></div>`),
    section('Principal lines', `
      <figure class="r-chart">${charts.pie}</figure>
      ${table(
        ['Rank', 'Line', 'Lines', 'Share', 'Owner', 'First written in'],
        stats.lines.map((l, k) => [
          cell(k + 1, k + 1),
          cell(l.binary === null ? '(unattributed)' : `<code class="r-lit">${esc(lineLabel(l, 80))}</code>`),
          cell(num(l.lines), l.lines),
          cell(pct(l.lines, stats.total), l.lines),
          cell(l.owner ? esc(l.owner.name) : ''),
          cell(esc(l.origin ?? '')),
        ]),
        ['num', '', 'num', 'num', '', ''],
      )}`),
    section('Cross-repository ownership', `
      <p class="r-note">Rows are the repository where a line lives; columns are the repository where that
      line was first written, and so where its owner acquired it. Hover a cell for the exact count.</p>
      <figure class="r-chart r-scroll">${charts.heatmap}</figure>
      ${table(
        ['Repository', 'Lines', 'Owned from other repos', 'Owned by non-contributors', 'Largest outside source'],
        stats.repos.map((r) => {
          const outside = r.origins.find((o) => o.repo !== null && o.repo !== r.name);
          return [
            cell(`<a href="#repo-${slug(r.name)}">${esc(r.name)}</a>`, r.name),
            cell(num(r.lines), r.lines),
            cell(pct(r.foreign, r.lines), share(r.foreign, r.lines)),
            cell(pct(r.absentee, r.lines), share(r.absentee, r.lines)),
            cell(outside ? `${esc(outside.repo)} (${pct(outside.lines, r.lines)})` : '', outside ? share(outside.lines, r.lines) : -1),
          ];
        }),
        ['', 'num', 'num', 'num', ''],
      )}
      <p class="r-note">Non-contributors own lines in a repository without a single commit to it.</p>`),
    section('Three ways to own a repository', `
      <p class="r-note">The top owner of each repository by commit count, by <code>git blame</code>, and by
      line hash. Blame shows "-" until <code>bin/ownh.js blame</code> has covered every file (or every file of its sample).
      Values marked ~ are estimates from a random sample of files, with a 95% margin in percentage points.</p>
      ${table(
        ['Repository', 'By commits', 'By blame', 'By line hash', 'Agree'],
        [methodRowHtml('All repositories', stats.methods, true), ...stats.repos.map((r) => methodRowHtml(r.name, r.methods))],
        ['', '', '', '', ''],
      )}
      <p class="r-note">The three methods agree on ${stats.repos.filter((r) => r.methods.agree).length} of ${stats.repos.length} repositories.</p>`),
    ...leverageHtml(stats),
    ...demolitionHtml(stats),
    ...(stats.survival ? [section('Code survival', `
      <ul class="r-outlook">${survivalStatements(stats).map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
      ${charts.survival ? `<figure class="r-chart">${charts.survival}</figure>` : ''}
      <p class="r-note">${esc(SURVIVAL_NOTE)}</p>`)] : []),
    ...(stats.timeline ? [section('Outlook', outlookHtml(stats, charts))] : []),
    section('Oddities', stats.oddities.length
      ? `<ul class="r-odd">${stats.oddities.map((o) => `<li><span class="r-odd-title">${esc(o.title)}.</span> <span class="r-odd-detail">${o.detail.map((p) => (p.code !== undefined ? `<code class="r-lit">${esc(p.code)}</code>` : esc(p.text))).join('')}</span></li>`).join('\n')}</ul>`
      : '<p class="r-note">None found.</p>'),
    section('Repositories', stats.repos.map((r) => `
      <details class="r-repo" id="repo-${slug(r.name)}">
        <summary><span class="r-repo-name">${esc(r.name)}</span>
          <span class="r-meta">${num(r.lines)} lines · ${pct(r.foreign, r.lines)} from other repos · ${pct(r.absentee, r.lines)} owned by non-contributors</span></summary>
        ${table(
          ['Rank', 'Owner', 'Lines', 'Share', 'Commits here'],
          r.owners.slice(0, top).map((o, k) => [
            cell(k + 1, k + 1),
            cell(esc(ownerLabel(o.owner))),
            cell(num(o.lines), o.lines),
            cell(pct(o.lines, r.lines), o.lines),
            cell(o.owner === null ? '' : o.contributor ? 'yes' : 'none'),
          ]),
          ['num', '', 'num', 'num', ''],
        )}
        ${originsTable(r)}
      </details>`).join('\n')),
  ];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OWNH Ownership Report</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main class="r-page">
${main.join('\n')}
${section('Excluded patterns', stats.excludes.length
    ? `<p class="r-note">Files matching these patterns were left out of history and the current tree: ${stats.excludes.map((e) => `<code>${esc(e)}</code>`).join(', ')}.</p>`
    : '<p class="r-note">None. Every file was analyzed.</p>')}
</main>
<script>${SORT_SCRIPT}</script>
</body>
</html>
`;
}

function methodRowHtml(name, m, strong = false) {
  const c = (t) => {
    if (!t) return cell('-', '');
    const title = t.estimate?.files ? ` title="estimated from ${t.estimate.files} of ${t.estimate.ofFiles} files"` : '';
    return cell(`${esc(t.owner.name)} <span class="r-dim"${title}>${methodShare(t)}</span>`, t.owner.name);
  };
  return [cell(strong ? `<strong>${esc(name)}</strong>` : esc(name), strong ? '' : name), c(m.commits), c(m.blame), c(m.hash), cell(m.agree ? 'yes' : 'no')];
}

function leverageHtml(stats) {
  const lev = leverage(stats);
  if (!lev) return [];
  const ratio = (r) => (r >= 10 ? num(Math.round(r)) : r.toFixed(2));
  const tbl = (list) => table(
    ['Owner', 'Lines written', 'Lines owned', 'Owned per line written'],
    list.map((r) => [cell(esc(ownerLabel(r.owner))), cell(num(r.written), r.written), cell(num(r.owned), r.owned), cell(ratio(r.ratio), r.ratio)]),
    ['', 'num', 'num', 'num'],
  );
  return [section('Leverage', `
    <p class="r-note">Lines owned today for every line written. Identical lines are owned by whoever wrote them first, so one line written can be many lines owned.</p>
    <h4>Highest leverage</h4>${tbl(lev.highest)}
    <h4>Lowest retention among the most prolific writers</h4>${tbl(lev.lowest)}`)];
}

function demolitionHtml(stats) {
  const d = stats.deletions;
  if (!d) return [];
  const tbl = (label, list) => table(
    ['Rank', label, 'Lines', 'Own lines removed'],
    list.map((r, k) => [cell(k + 1, k + 1), cell(esc(ownerLabel(r.owner))), cell(num(r.lines), r.lines), cell(num(r.ownRemoved), r.ownRemoved)]),
    ['num', '', 'num', 'num'],
  );
  return [section('Code demolition', `
    <p class="r-note">${num(d.added)} lines added and ${num(d.removed)} removed in total; ${num(d.removedOfOthers)} of the removed lines (${pct(d.removedOfOthers, d.removed)}) belonged to someone other than the person removing them.</p>
    <h4>Most lines removed that belonged to others</h4>${tbl('Remover', d.topRemovers)}
    <h4>Most lines lost to others</h4>${tbl('Owner', d.mostRemovedOwners)}
    <p class="r-note">${esc(DEMOLITION_NOTE)}</p>`)];
}

function outlookHtml(stats, charts) {
  const t = stats.timeline;
  const pctOrDash = (v) => (v === null ? '-' : pct(v, 1));
  const change = (v) => {
    if (v === null) return cell('-', '');
    const cls = v > 0 ? 'r-up' : v < 0 ? 'r-down' : '';
    const arrow = v > 0 ? '\u25B2 ' : v < 0 ? '\u25BC ' : '';
    return cell(`<span class="${cls}">${arrow}${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%</span>`, v);
  };
  return `
    <ul class="r-outlook">${outlookStatements(t).map((s) => `<li><b>${esc(s.label)}:</b> ${esc(s.text)}</li>`).join('')}</ul>
    <div class="r-pair">
      ${charts.shares ? `<figure class="r-chart">${charts.shares}</figure>` : ''}
      ${charts.blank ? `<figure class="r-chart">${charts.blank}</figure>` : ''}
    </div>
    ${table(
      ['Quarter', 'Lines under management', 'QoQ', 'New owners', t.principal ? esc(t.principal.name) : 'Principal owner', 'Non-contributors', 'Inactive owners', 'Blank lines committed'],
      t.kpis.map((k) => [
        cell(esc(k.quarter), k.quarter),
        cell(num(k.lines), k.lines),
        change(k.linesChange),
        cell(num(k.newOwners), k.newOwners),
        cell(pctOrDash(k.principalShare), k.principalShare),
        cell(pctOrDash(k.nonContributorShare), k.nonContributorShare),
        cell(pctOrDash(k.inactiveShare), k.inactiveShare),
        cell(k.blank === null ? '-' : num(k.blank), k.blank ?? ''),
      ]),
      ['', 'num', 'num', 'num', 'num', 'num', 'num', 'num'],
    )}
    <p class="r-note">${esc(outlookNote(t))}</p>`;
}

function originsTable(r) {
  const rows = r.origins.filter((o) => o.repo !== null && o.repo !== r.name);
  if (rows.length === 0) return '';
  return `<h4>Lines first written in other repositories</h4>${table(
    ['Origin', 'Lines', 'Share of this repo'],
    rows.map((o) => [cell(esc(o.repo)), cell(num(o.lines), o.lines), cell(pct(o.lines, r.lines), o.lines)]),
    ['', 'num', 'num'],
  )}`;
}

function tile(label, value, sub = '') {
  return `<div class="r-tile"><div class="r-tile-label">${label}</div><div class="r-tile-value">${value}</div>${sub ? `<div class="r-tile-sub">${sub}</div>` : ''}</div>`;
}

function section(title, body) {
  return `<section class="r-section"><h2>${title}</h2>${body}</section>`;
}

// A cell is { html, sort }; sort is the value the column sorts by.
function cell(html, sort) {
  return { html: String(html), sort: sort ?? null };
}

function table(header, rows, kinds) {
  const head = header.map((h, c) => `<th class="${kinds[c]}" data-col="${c}">${h}</th>`).join('');
  const body = rows.map((r) => `<tr>${r.map((v, c) => {
    const sort = v.sort === null ? '' : ` data-sort="${esc(String(v.sort))}"`;
    return `<td class="${kinds[c]}"${sort}>${v.html}</td>`;
  }).join('')}</tr>`).join('\n');
  return `<div class="r-scroll"><table class="r-table"><thead><tr>${head}</tr></thead><tbody>\n${body}\n</tbody></table></div>`;
}

function num(n) {
  return Number(n).toLocaleString('en-US');
}

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const PAGE_STYLE = `
:root {
  color-scheme: light;
  --r-surface: #fcfcfb; --r-raised: #ffffff; --r-border: #e4e3de;
  --r-text: #0b0b0b; --r-text-2: #52514e; --r-accent: #256abf; --r-code: #f0efec;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --r-surface: #1a1a19; --r-raised: #232322; --r-border: #383835;
    --r-text: #ffffff; --r-text-2: #c3c2b7; --r-accent: #6da7ec; --r-code: #2c2c2a;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --r-surface: #1a1a19; --r-raised: #232322; --r-border: #383835;
  --r-text: #ffffff; --r-text-2: #c3c2b7; --r-accent: #6da7ec; --r-code: #2c2c2a;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--r-surface); color: var(--r-text);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
.r-page { max-width: 1200px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 28px; margin: 0 0 8px; }
h2 { font-size: 20px; margin: 0 0 16px; }
h4 { font-size: 14px; margin: 20px 0 8px; color: var(--r-text-2); }
a { color: var(--r-accent); }
code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 13px; }
.r-lit { background: var(--r-code); padding: 1px 6px; border-radius: 4px; white-space: pre; }
.r-dim { color: var(--r-text-2); }
.r-pair { display: grid; gap: 16px; }
@media (min-width: 1100px) { .r-pair { grid-template-columns: 1fr 1fr; } }
.r-odd { margin: 0; padding-left: 20px; display: grid; gap: 8px; max-width: 900px; }
.r-odd li { line-height: 1.55; }
.r-odd-title { font-weight: 500; }
.r-odd-detail { color: var(--r-text-2); }
.r-outlook { margin: 0 0 20px; padding-left: 20px; display: grid; gap: 8px; max-width: 900px; }
.r-outlook b { font-weight: 600; }
.r-up { color: #1a8a5a; }
.r-down { color: #c2412d; }
.r-meta, .r-note { color: var(--r-text-2); margin: 4px 0; font-size: 14px; }
.r-section { margin-top: 48px; }
.r-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-top: 24px; }
.r-tile { background: var(--r-raised); border: 1px solid var(--r-border); border-radius: 8px; padding: 14px 16px; }
.r-tile-label { color: var(--r-text-2); font-size: 13px; }
.r-tile-value { font-size: 24px; font-weight: 600; margin-top: 4px; overflow-wrap: anywhere; }
.r-tile-sub { color: var(--r-text-2); font-size: 13px; }
.r-chart { margin: 0 0 16px; }
.r-chart svg { max-width: 100%; height: auto; display: block; }
.r-scroll { overflow-x: auto; }
.r-scroll > svg { max-width: none; }
.r-table { border-collapse: collapse; width: 100%; font-size: 14px; }
.r-table th, .r-table td { padding: 6px 10px; border-bottom: 1px solid var(--r-border); text-align: left; white-space: nowrap; }
.r-table th { color: var(--r-text-2); font-weight: 600; cursor: pointer; user-select: none; }
.r-table th[aria-sort="ascending"]::after { content: " \\2191"; }
.r-table th[aria-sort="descending"]::after { content: " \\2193"; }
.r-table .num { text-align: right; font-variant-numeric: tabular-nums; }
.r-repo { border: 1px solid var(--r-border); border-radius: 8px; background: var(--r-raised); margin-bottom: 8px; padding: 8px 14px; }
.r-repo summary { cursor: pointer; display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; }
.r-repo-name { font-weight: 600; }
.r-repo[open] { padding-bottom: 14px; }
`;

// Click a header to sort by that column; numeric when every value parses.
// Links to a repo section open its <details> before jumping to it.
const SORT_SCRIPT = `
function openTarget() {
  const el = location.hash && document.getElementById(location.hash.slice(1));
  if (el && el.tagName === 'DETAILS') { el.open = true; el.scrollIntoView(); }
}
window.addEventListener('hashchange', openTarget);
openTarget();
document.querySelectorAll('.r-table').forEach((table) => {
  table.querySelectorAll('th').forEach((th) => {
    th.addEventListener('click', () => {
      const col = Number(th.dataset.col);
      const dir = th.getAttribute('aria-sort') === 'descending' ? 'ascending' : 'descending';
      table.querySelectorAll('th').forEach((h) => h.removeAttribute('aria-sort'));
      th.setAttribute('aria-sort', dir);
      const body = table.tBodies[0];
      const rows = [...body.rows];
      const key = (r) => { const c = r.cells[col]; return c.dataset.sort ?? c.textContent; };
      const numeric = rows.every((r) => key(r) === '' || !Number.isNaN(Number(key(r))));
      rows.sort((a, b) => {
        const x = key(a), y = key(b);
        const d = numeric ? Number(x) - Number(y) : String(x).localeCompare(String(y));
        return dir === 'ascending' ? d : -d;
      });
      rows.forEach((r) => body.appendChild(r));
    });
  });
});
`;
