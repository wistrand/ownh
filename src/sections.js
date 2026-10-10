// Report pieces built on churn and per-author line counts: leverage, code
// demolition, and code survival. Shared by leaderboard.md and report.html.
import { trendSvg } from './charts.js';

// Owners below this many lines (or 1% of all lines, if smaller) are left out of
// the leverage ranking, so three lines from one keystroke don't top the table.
const MIN_OWNED = 100;
const ROWS = 10;
// Survival curves are drawn up to this age.
const MAX_AGE_QUARTERS = 40;

// Lines owned per line written (lines added in their own commits).
export function leverage(stats) {
  const rows = stats.owners
    .filter((o) => o.owner && o.written !== null && o.written > 0)
    .map((o) => ({ owner: o.owner, written: o.written, owned: o.lines, ratio: o.lines / o.written }));
  if (rows.length === 0) return null;
  const minOwned = Math.min(MIN_OWNED, Math.ceil(stats.total * 0.01));
  const highest = rows.filter((r) => r.owned >= minOwned)
    .sort((a, b) => b.ratio - a.ratio || b.owned - a.owned).slice(0, ROWS);
  // Retention among the people who wrote the most.
  const writers = [...rows].sort((a, b) => b.written - a.written).slice(0, 20);
  const lowest = writers.sort((a, b) => a.ratio - b.ratio || b.written - a.written).slice(0, ROWS);
  return { highest, lowest };
}

export function survivalStatements(stats) {
  const s = stats.survival;
  if (!s) return [];
  const line = (who, curve) => {
    if (!curve || curve.lines === 0) return `${who}: no lines recorded.`;
    // Survival stays at 1 only if no line was ever removed.
    if (curve.curve.every((s) => s === 1)) return `${who}: no lines have been deleted.`;
    // Deletions, but too little history to reach or project a half-life (every
    // line is from the newest quarter).
    if (curve.halfLife === null) return `${who}: ${pct(curve.curve.at(-1))} of lines survive; not enough history for a half-life.`;
    const years = (curve.halfLife / 4).toFixed(1);
    return curve.projected
      ? `${who}: half-life of ${years} years (projected; ${pct(curve.curve.at(-1))} of lines survive after ${((curve.curve.length - 1) / 4).toFixed(1)} years).`
      : `${who}: half-life of ${years} years.`;
  };
  return [line('All code', s.all), ...s.owners.map((o) => line(o.owner.name, o))];
}

export function survivalSvg(stats) {
  const s = stats.survival;
  if (!s || !s.all || s.all.curve.length < 2) return null;
  const series = [
    { name: 'All code', values: s.all.curve.slice(0, MAX_AGE_QUARTERS + 1), projection: null },
    ...s.owners.filter((o) => o.curve.length > 1).map((o) => ({ name: o.owner.name, values: o.curve.slice(0, MAX_AGE_QUARTERS + 1), projection: null })),
  ];
  const len = Math.max(...series.map((x) => x.values.length));
  return trendSvg({
    title: 'Code survival',
    subtitle: 'Share of lines still present, by age, for lines owned by each owner (Kaplan-Meier)',
    quarters: Array.from({ length: len }, (_, i) => i),
    series,
    yMax: 1,
    yFormat: (v) => `${Math.round(v * 100)}%`,
    target: { value: 0.5, label: 'half-life' },
    xTick: (q) => (q % 4 === 0 ? `${q / 4}y` : null),
    xFormat: (q) => `${q} quarters`,
    nowLine: false,
  });
}

export const SURVIVAL_NOTE = 'Copies of the same line are indistinguishable, so removals are paired with the ' +
  'oldest surviving copies of that line first. Lines still present count as surviving at their current age. ' +
  'A half-life marked projected extends an exponential decay through the last point.';

export const DEMOLITION_NOTE = 'Removals inside merge commits are not counted: they are relative to git\'s ' +
  're-run of the merge, not to a parent.';

function pct(v) {
  return `${(v * 100).toFixed(1)}%`;
}
