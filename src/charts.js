// Standalone SVG charts for the report. Colors follow the dataviz reference
// palette (categorical slots 1-5, blue sequential ramp), with light and dark
// steps selected by prefers-color-scheme inside the SVG. Every mark carries a
// <title> so hovering in a browser shows the exact numbers; leaderboard.md is
// the table view.
import { lineLabel, pct, share } from './stats.js';

const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

// Plain hex in class rules, not CSS variables: rsvg, Inkscape, and slide tools
// ignore var(). Dark values override inside the prefers-color-scheme block.
const THEME = {
  light: {
    surface: '#fcfcfb', primary: '#0b0b0b', secondary: '#52514e',
    series: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4'], other: '#c9c8c1',
    // Bin 0 = no lines; bins 1-8 = blue ramp, lightest near zero.
    bins: ['#f0efec', '#cde2fb', '#b7d3f6', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'],
    binText: [null, '#0b0b0b', '#0b0b0b', '#0b0b0b', '#0b0b0b', '#ffffff', '#ffffff', '#ffffff', '#ffffff'],
  },
  dark: {
    surface: '#1a1a19', primary: '#ffffff', secondary: '#c3c2b7',
    series: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181'], other: '#4a4945',
    // Reversed so near-zero recedes toward the dark surface.
    bins: ['#262625', '#0d366b', '#184f95', '#256abf', '#3987e5', '#6da7ec', '#9ec5f4', '#b7d3f6', '#cde2fb'],
    binText: [null, '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#0b0b0b', '#0b0b0b', '#0b0b0b', '#0b0b0b'],
  },
};

function colorRules(t) {
  return [
    `.bg { fill: ${t.surface}; }`,
    `.title, .label, .mono, .axis { fill: ${t.primary}; }`,
    `.subtitle, .muted, .axis-title { fill: ${t.secondary}; }`,
    `.slice { stroke: ${t.surface}; }`,
    `.self { stroke: ${t.secondary}; }`,
    ...t.series.map((c, k) => `.s${k + 1} { fill: ${c}; }`),
    `.other { fill: ${t.other}; }`,
    ...t.bins.map((c, k) => `.b${k} { fill: ${c}; }`),
    ...t.binText.map((c, k) => (c ? `.t${k} { fill: ${c}; }` : '')).filter(Boolean),
  ].join('\n');
}

const STYLE = `
.title { font-family: ${FONT}; font-size: 20px; font-weight: 600; }
.subtitle, .label { font-family: ${FONT}; font-size: 13px; }
.mono { font-family: ${MONO}; font-size: 13px; }
.muted, .axis { font-family: ${FONT}; font-size: 12px; }
.axis-title { font-family: ${FONT}; font-size: 12px; font-weight: 600; }
.value { font-family: ${FONT}; font-size: 11px; font-weight: 500; text-anchor: middle; }
.slice { stroke-width: 2; stroke-linejoin: round; }
.self { fill: none; stroke-width: 1.5; }
${colorRules(THEME.light)}
@media (prefers-color-scheme: dark) {
${colorRules(THEME.dark)}
}
`;

// --- Pie: share of all lines held by the top line hashes --------------------

// Pie charts read only with few segments: five lines plus "everything else".
const PIE_SLICES = 5;

export function lineSharePieSvg(stats) {
  const top = stats.lines.slice(0, PIE_SLICES);
  const rest = stats.total - top.reduce((s, l) => s + l.lines, 0);
  const segments = [
    ...top.map((l, k) => ({
      cls: `s${k + 1}`,
      label: lineLabel(l, 36),
      detail: `${l.owner ? l.owner.name : 'unattributed'} · ${pct(l.lines, stats.total)}`,
      lines: l.lines,
    })),
    { cls: 'other', label: 'Everything else', detail: `all other lines · ${pct(rest, stats.total)}`, lines: rest, plain: true },
  ];

  const width = 760;
  const height = 120 + Math.max(300, segments.length * 46);
  const cx = 190;
  const cy = 110 + 150;
  const r = 150;
  let angle = -Math.PI / 2;
  const slices = segments.map((s) => {
    const sweep = share(s.lines, stats.total) * 2 * Math.PI;
    const path = arcPath(cx, cy, r, angle, angle + sweep);
    angle += sweep;
    return `<path class="slice ${s.cls}" d="${path}"><title>${esc(`${s.label}: ${s.lines.toLocaleString('en-US')} lines (${pct(s.lines, stats.total)})`)}</title></path>`;
  });
  const legend = segments.map((s, k) => {
    const y = 132 + k * 46;
    return [
      `<rect class="${s.cls}" x="380" y="${y - 11}" width="12" height="12" rx="3"/>`,
      `<text class="${s.plain ? 'label' : 'mono'}" x="402" y="${y}" xml:space="preserve">${esc(s.label)}</text>`,
      `<text class="muted" x="402" y="${y + 18}">${esc(s.detail)}</text>`,
    ].join('');
  });

  return svgDoc(width, height, [
    `<text class="title" x="24" y="40">Ownership by line hash</text>`,
    `<text class="subtitle" x="24" y="62">Share of ${stats.total.toLocaleString('en-US')} lines across ${stats.repos.length} repositories held by each line</text>`,
    ...slices,
    ...legend,
  ]);
}

function arcPath(cx, cy, r, a0, a1) {
  if (a1 - a0 >= 2 * Math.PI - 1e-9) {
    // A full circle can't be one arc; draw two halves.
    return `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx} ${cy + r} A ${r} ${r} 0 1 1 ${cx} ${cy - r} Z`;
  }
  const p = (a) => `${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M ${cx} ${cy} L ${p(a0)} A ${r} ${r} 0 ${large} 1 ${p(a1)} Z`;
}

// --- Heatmap: where each repo's lines were first written --------------------

// Bin edges (share of the row repo's lines). Bin 0 is "none"; bins 1-8 use the
// blue ramp, lightest near zero in light mode and darkest near zero in dark mode
// so small values recede toward the surface either way.
const BIN_EDGES = [0, 0.01, 0.025, 0.05, 0.1, 0.2, 0.4, 0.6, 1];
// Label at the left edge of each legend swatch, plus the final right edge.
const BIN_LABELS = ['0', '>0', '1', '2.5', '5', '10', '20', '40', '60'];
const BIN_END_LABEL = '100%';

function bin(s) {
  if (s <= 0) return 0;
  for (let b = 1; b < BIN_EDGES.length; b++) if (s < BIN_EDGES[b]) return b;
  return BIN_EDGES.length - 1;
}

export function crossOwnershipSvg(stats) {
  const names = stats.repos.map((r) => r.name);
  const cell = 30;
  const gap = 2;
  const step = cell + gap;
  const charW = 7;
  const longest = Math.max(...names.map((n) => n.length), 4);
  const left = 24 + longest * charW + 12;
  const colLabelHeight = Math.round(longest * charW * 0.82) + 16;
  const top = 96 + colLabelHeight;
  const gridW = names.length * step;
  // Rotated column labels reach past the last column by about cos(55deg) of their length.
  const width = Math.max(left + gridW + Math.round(longest * charW * 0.6) + 24, 720);
  const height = top + gridW + 96;

  const parts = [
    `<text class="title" x="24" y="40">Cross-repository ownership</text>`,
    `<text class="subtitle" x="24" y="62">Share of each repository's lines (row) by the repository where each line was first written (column)</text>`,
    `<text class="axis-title" x="${left}" y="${92}">First written in</text>`,
  ];
  names.forEach((name, c) => {
    const x = left + c * step + cell / 2 + 4;
    parts.push(`<text class="axis" transform="translate(${x} ${top - 8}) rotate(-55)">${esc(name)}</text>`);
  });
  stats.repos.forEach((repo, rIdx) => {
    const y = top + rIdx * step;
    parts.push(`<text class="axis" x="${left - 10}" y="${y + cell / 2 + 4}" text-anchor="end">${esc(repo.name)}</text>`);
    const byOrigin = new Map(repo.origins.map((o) => [o.repo, o.lines]));
    names.forEach((origin, c) => {
      const x = left + c * step;
      const n = byOrigin.get(origin) ?? 0;
      const s = share(n, repo.lines);
      const b = bin(s);
      const tip = `${repo.name}: ${n.toLocaleString('en-US')} of ${repo.lines.toLocaleString('en-US')} lines first written in ${origin} (${pct(n, repo.lines)})`;
      parts.push(`<rect class="b${b}" x="${x}" y="${y}" width="${cell}" height="${cell}" rx="3"><title>${esc(tip)}</title></rect>`);
      if (s >= 0.01) {
        parts.push(`<text class="value t${b}" x="${x + cell / 2}" y="${y + cell / 2 + 4}" pointer-events="none">${Math.round(s * 100)}</text>`);
      }
      if (origin === repo.name) {
        parts.push(`<rect class="self" x="${x + 0.75}" y="${y + 0.75}" width="${cell - 1.5}" height="${cell - 1.5}" rx="3" pointer-events="none"/>`);
      }
    });
  });

  // Legend: binned ramp with edge labels.
  const ly = top + gridW + 36;
  const sw = 44;
  parts.push(`<text class="muted" x="${left}" y="${ly - 10}">% of the row repository's lines; outlined cells are the repository itself</text>`);
  for (let b = 0; b < BIN_EDGES.length; b++) {
    const x = left + b * (sw + 2);
    parts.push(`<rect class="b${b}" x="${x}" y="${ly}" width="${sw}" height="12" rx="3"/>`);
    parts.push(`<text class="muted" x="${x}" y="${ly + 28}">${BIN_LABELS[b]}</text>`);
  }
  parts.push(`<text class="muted" x="${left + BIN_EDGES.length * (sw + 2)}" y="${ly + 28}">${BIN_END_LABEL}</text>`);

  return svgDoc(width, height, parts);
}

// --- shared ------------------------------------------------------------------

function svgDoc(width, height, body) {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">`,
    `<style>${STYLE}</style>`,
    `<rect class="bg" width="${width}" height="${height}"/>`,
    ...body,
    '</svg>',
    '',
  ].join('\n');
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
