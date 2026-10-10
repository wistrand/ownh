import { quarterLabel } from './quarters.js';

// Time series and projections for the report's "Outlook" section.
//
// Two modes (`mode` in buildTimeline):
//   history  databases with churn: lines added minus lines removed per owner and
//            quarter, summed over all branches. Not a sequence of snapshots:
//            removals inside merges are not counted, so the total can drift
//            from the lines at HEAD; the report states the gap.
//   cohort   older databases: lines that exist at HEAD today, grouped by the
//            quarter their owner first wrote them. Deleted lines are invisible.
// The blank-line series counts blank lines as committed, from the per-commit
// counters recorded during indexing.
//
// "Now" is the quarter of the newest commit in the database (merges included),
// not the clock, so a report built twice from the same database is identical.

// Quarter helpers live in quarters.js (so cached stats stages that only need
// them do not depend on this file); re-exported for existing importers.
export { QUARTER_SQL, quarterLabel, quarterOf } from './quarters.js';

// Projections take the slope of a least-squares line through the last
// FIT_QUARTERS quarters and continue it from the latest actual value, so the
// drawn projection starts where the data ends and the projected dates match it.
export const FIT_QUARTERS = 12;
// Fewer quarters than this and there is nothing meaningful to fit.
const MIN_FIT_QUARTERS = 3;
// A projection further out than this is reported as "beyond" instead of a date.
const HORIZON_QUARTERS = 40;
// An owner is inactive in quarter Q without a commit in Q or the 3 quarters before.
const ACTIVE_WINDOW = 4;
// The KPI table covers this many quarters.
export const KPI_QUARTERS = 8;

// mode: 'history' when cohorts are net additions minus removals (a true
// history), 'cohort' when they are surviving lines by first-written quarter.
export function buildTimeline({ cohorts, mode = 'cohort', commitQuarters, blankByQuarter, contributed, principal }) {
  if (cohorts.length === 0 || commitQuarters.length === 0) return null;
  // Loops, not Math.max(...rows): spreading hundreds of thousands of rows as
  // arguments overflows the call stack on large databases.
  let now = -Infinity;
  for (const c of commitQuarters) if (c.q > now) now = c.q;
  let first = Infinity;
  for (const c of cohorts) if (c.q < first) first = c.q;
  const quarters = [];
  for (let q = first; q <= now; q++) quarters.push(q);
  const index = new Map(quarters.map((q, i) => [q, i]));
  const zeros = () => quarters.map(() => 0);

  // Lines first written per quarter, in total and by category.
  const added = zeros();
  const byPrincipal = zeros();
  const byNonContributor = zeros();
  const firstQuarterOf = new Map();
  const perOwner = new Map(); // identityId -> per-quarter added lines
  for (const { repoId, identityId, q, n } of cohorts) {
    const i = index.get(q);
    if (i === undefined) continue; // written after the newest commit's quarter: not possible, but safe
    added[i] += n;
    if (principal && identityId === principal.identityId) byPrincipal[i] += n;
    if (!contributed.has(`${repoId}:${identityId}`)) byNonContributor[i] += n;
    firstQuarterOf.set(identityId, Math.min(firstQuarterOf.get(identityId) ?? Infinity, q));
    if (!perOwner.has(identityId)) perOwner.set(identityId, zeros());
    perOwner.get(identityId)[i] += n;
  }
  const total = cumulative(added);
  const principalShare = ratio(cumulative(byPrincipal), total);
  const nonContributorShare = ratio(cumulative(byNonContributor), total);

  // Share owned by people with no commit in the active window ending at Q.
  const activeQuarters = new Map();
  for (const { identityId, q } of commitQuarters) {
    if (!activeQuarters.has(identityId)) activeQuarters.set(identityId, new Set());
    activeQuarters.get(identityId).add(q);
  }
  const ownedCum = new Map([...perOwner].map(([id, series]) => [id, cumulative(series)]));
  const inactiveShare = quarters.map((q, i) => {
    let inactive = 0;
    for (const [id, cum] of ownedCum) {
      const seen = activeQuarters.get(id);
      let active = false;
      for (let k = 0; k < ACTIVE_WINDOW && !active; k++) active = seen?.has(q - k) ?? false;
      if (!active) inactive += cum[i];
    }
    return total[i] ? inactive / total[i] : 0;
  });

  const newOwners = zeros();
  for (const q of firstQuarterOf.values()) newOwners[index.get(q)]++;

  let blank = null;
  if (blankByQuarter) {
    const perQ = zeros();
    for (const { q, n } of blankByQuarter) if (index.has(q)) perQ[index.get(q)] += n ?? 0;
    blank = cumulative(perQ);
  }

  const series = {
    quarters,
    total,
    principalShare,
    nonContributorShare,
    inactiveShare,
    newOwners,
    blank,
  };
  return {
    mode,
    now,
    nowLabel: quarterLabel(now),
    principal: principal ? { name: principal.owner.name, email: principal.owner.email } : null,
    series,
    kpis: kpiRows(series),
    projections: {
      knowledgeLoss: projectShare(quarters, inactiveShare, 0.5),
      principal: principal ? projectShare(quarters, principalShare, 0.5) : null,
      blank: blank ? projectMilestone(quarters, blank) : null,
    },
  };
}

function kpiRows(s) {
  const n = s.quarters.length;
  const rows = [];
  for (let i = Math.max(0, n - KPI_QUARTERS); i < n; i++) {
    rows.push({
      quarter: quarterLabel(s.quarters[i]),
      lines: s.total[i],
      linesChange: i > 0 && s.total[i - 1] ? s.total[i] / s.total[i - 1] - 1 : null,
      newOwners: s.newOwners[i],
      principalShare: s.principalShare[i],
      nonContributorShare: s.nonContributorShare[i],
      inactiveShare: s.inactiveShare[i],
      blank: s.blank ? s.blank[i] : null,
    });
  }
  return rows;
}

// Least-squares line through (x, y); returns { slope, intercept, r2 }.
export function fitLine(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  const slope = sxx ? sxy / sxx : 0;
  const intercept = my - slope * mx;
  const r2 = sxx && syy ? (sxy * sxy) / (sxx * syy) : 0;
  return { slope, intercept, r2 };
}

function lastWindow(quarters, values) {
  const from = Math.max(0, quarters.length - FIT_QUARTERS);
  return { xs: quarters.slice(from), ys: values.slice(from) };
}

// When a share series reaches `target`: already reached (and since when), a
// projected quarter from the fit, or not on the current trajectory.
function projectShare(quarters, values, target) {
  const { xs, ys } = lastWindow(quarters, values);
  const fit = fitLine(xs, ys);
  const current = values[values.length - 1];
  const base = { target, current, fit, fitFrom: quarterLabel(xs[0]), fitTo: quarterLabel(xs[xs.length - 1]) };
  if (xs.length < MIN_FIT_QUARTERS) return { ...base, status: 'insufficient' };
  if (current >= target) {
    let since = values.length - 1;
    while (since > 0 && values[since - 1] >= target) since--;
    return { ...base, status: 'reached', quarter: quarterLabel(quarters[since]) };
  }
  if (fit.slope <= 0) return { ...base, status: 'not-on-track' };
  const now = quarters[quarters.length - 1];
  const at = now + Math.ceil((target - current) / fit.slope);
  if (at - now > HORIZON_QUARTERS) return { ...base, status: 'beyond', quarter: quarterLabel(now + HORIZON_QUARTERS) };
  return { ...base, status: 'projected', quarter: quarterLabel(Math.max(at, now + 1)) };
}

// The next round number (1, 2, or 5 times a power of ten) above the current
// count, and when the fit reaches it.
function projectMilestone(quarters, values) {
  const current = values[values.length - 1];
  const milestone = nextRound(current);
  const { xs, ys } = lastWindow(quarters, values);
  const fit = fitLine(xs, ys);
  const base = { current, milestone, fit, fitFrom: quarterLabel(xs[0]), fitTo: quarterLabel(xs[xs.length - 1]) };
  if (xs.length < MIN_FIT_QUARTERS) return { ...base, status: 'insufficient' };
  if (fit.slope <= 0) return { ...base, status: 'not-on-track' };
  const now = quarters[quarters.length - 1];
  const at = now + Math.ceil((milestone - current) / fit.slope);
  if (at - now > HORIZON_QUARTERS) return { ...base, status: 'beyond', quarter: quarterLabel(now + HORIZON_QUARTERS) };
  return { ...base, status: 'projected', quarter: quarterLabel(Math.max(at, now + 1)) };
}

export function nextRound(n) {
  let p = 1;
  for (;;) {
    for (const m of [1, 2, 5]) if (m * p > n) return m * p;
    p *= 10;
  }
}

// Projected values for quarters after `now`, for drawing the dashed line.
export function projectionPoints(projection, now, quarters = 8) {
  const out = [];
  for (let q = now; q <= now + quarters; q++) out.push({ q, v: projection.current + projection.fit.slope * (q - now) });
  return out;
}

function cumulative(values) {
  let sum = 0;
  return values.map((v) => (sum += v));
}

function ratio(a, b) {
  return a.map((v, i) => (b[i] ? v / b[i] : 0));
}
