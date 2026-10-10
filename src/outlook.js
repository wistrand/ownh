// The report's "Outlook" section: projection statements and charts built from
// the timeline (see timeline.js). Shared by leaderboard.md and report.html.
import { trendSvg } from './charts.js';
import { FIT_QUARTERS, projectionPoints, quarterLabel } from './timeline.js';

// Quarters of history drawn before "now", and quarters of projection after it.
const HISTORY_QUARTERS = 20;
const PROJECTION_QUARTERS = 8;

export function outlookNote(t) {
  const fit = `Projections continue the trend of the last ${FIT_QUARTERS} quarters (least-squares slope) from the latest value. `;
  const series = t.mode === 'history'
    ? `Series are lines added minus lines removed, each line owned by whoever first wrote it; at ${t.nowLabel} they total ${num(t.series.total.at(-1))} lines against ${num(t.headLines)} at HEAD (lines added on branches whose changes a merge discarded are never removed). `
    : 'Series count lines that exist today, by the quarter their owner first wrote them, so deleted code is not included. ';
  return `${fit}${series}The blank-line series counts blank lines as committed. "Inactive" means no commit in the current or previous three quarters. "Now" is the quarter of the newest commit analyzed.`;
}

export function outlookStatements(t) {
  if (!t) return [];
  const out = [];
  const p = t.projections;
  out.push({ label: 'Knowledge retention', text: shareStatement(p.knowledgeLoss, 'contributors with no commit in the past year', true) });
  if (p.principal && t.principal) {
    out.push({ label: 'Principal owner', text: shareStatement(p.principal, t.principal.name, false) });
  }
  if (p.blank) {
    out.push({ label: 'Blank lines', text: milestoneStatement(p.blank) });
  }
  return out;
}

// `plural`: the subject is a group ("inactive contributors") rather than a person.
function shareStatement(p, subject, plural) {
  const now = pct(p.current);
  // Groups start the sentence capitalized; a person's name is left as written.
  const Subject = plural ? cap(subject) : subject;
  const fit = `fit over ${p.fitFrom} to ${p.fitTo}, R² ${p.fit.r2.toFixed(2)}`;
  switch (p.status) {
    case 'insufficient': return `${Subject} ${plural ? 'own' : 'owns'} ${now} of the codebase; there is not enough history to project.`;
    case 'reached': return `${Subject} ${plural ? 'have' : 'has'} owned the majority of the codebase since ${p.quarter} (now ${now}).`;
    case 'projected': return `At the current rate, ${subject} will own the majority of the codebase by ${p.quarter} (now ${now}; ${fit}).`;
    case 'beyond': return `At the current rate, ${subject} will not own the majority of the codebase before ${p.quarter} (now ${now}; ${fit}).`;
    default: return `${Subject} ${plural ? 'own' : 'owns'} ${now} of the codebase, and the trend is flat or falling (${fit}).`;
  }
}

function milestoneStatement(p) {
  const fit = `fit over ${p.fitFrom} to ${p.fitTo}, R² ${p.fit.r2.toFixed(2)}`;
  const now = `${num(p.current)} blank lines have been committed`;
  switch (p.status) {
    case 'insufficient': return `${now}; there is not enough history to project.`;
    case 'projected': return `${now}. At the current rate, the ${num(p.milestone)}th arrives in ${p.quarter} (${fit}).`;
    case 'beyond': return `${now}. The ${num(p.milestone)}th is not expected before ${p.quarter} (${fit}).`;
    default: return `${now}, and the rate is not increasing (${fit}).`;
  }
}

export function outlookCharts(t) {
  if (!t) return { shares: null, blank: null };
  const s = t.series;
  const from = Math.max(0, s.quarters.length - HISTORY_QUARTERS);
  const quarters = s.quarters.slice(from);
  const proj = (p) => (p && p.fit && p.status !== 'insufficient' ? projectionPoints(p, t.now, PROJECTION_QUARTERS).map(({ q, v }) => ({ q, v: clamp(v, 0, 1) })) : null);
  const shares = trendSvg({
    title: 'Ownership outlook',
    subtitle: `Share of the codebase, by quarter, with projections to ${quarterLabel(t.now + PROJECTION_QUARTERS)}`,
    quarters,
    series: [
      { name: 'Inactive owners', values: s.inactiveShare.slice(from), projection: proj(t.projections.knowledgeLoss) },
      ...(t.principal ? [{ name: t.principal.name, values: s.principalShare.slice(from), projection: proj(t.projections.principal) }] : []),
      { name: 'Non-contributors', values: s.nonContributorShare.slice(from), projection: null },
    ],
    yMax: 1,
    yFormat: (v) => `${Math.round(v * 100)}%`,
    target: { value: 0.5, label: 'majority' },
    label: t.nowLabel,
  });
  let blank = null;
  if (s.blank && t.projections.blank) {
    const p = t.projections.blank;
    const values = s.blank.slice(from);
    const projection = p.fit && !['not-on-track', 'insufficient'].includes(p.status) ? projectionPoints(p, t.now, PROJECTION_QUARTERS) : null;
    const top = niceTop(Math.max(p.milestone, ...values, ...(projection ?? []).map((x) => x.v)));
    blank = trendSvg({
      title: 'Blank line outlook',
      subtitle: 'Blank lines committed, cumulative, with projection',
      quarters,
      series: [{ name: 'Blank lines committed', values, projection }],
      yMax: top,
      yFormat: compact,
      target: { value: p.milestone, label: compact(p.milestone) },
      label: t.nowLabel,
    });
  }
  return { shares, blank };
}

// The smallest 1, 2, 4 or 8 times a power of ten at or above n, so the four
// gridline steps (a quarter of the top each) are round numbers.
function niceTop(n) {
  let p = 1;
  for (;;) {
    for (const m of [1, 2, 4, 8]) if (m * p >= n) return m * p;
    p *= 10;
  }
}

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

function pct(v) {
  return `${(v * 100).toFixed(1)}%`;
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function num(n) {
  return Number(n).toLocaleString('en-US');
}

function compact(n) {
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}k`;
  return String(+n.toFixed(1));
}
