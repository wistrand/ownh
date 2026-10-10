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
    surface: '#fcfcfb', primary: '#0b0b0b', secondary: '#52514e', grid: '#dcdbd5',
    series: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4'], other: '#c9c8c1',
    // Bin 0 = no lines; bins 1-8 = blue ramp, lightest near zero.
    bins: ['#f0efec', '#cde2fb', '#b7d3f6', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'],
    binText: [null, '#0b0b0b', '#0b0b0b', '#0b0b0b', '#0b0b0b', '#ffffff', '#ffffff', '#ffffff', '#ffffff'],
  },
  dark: {
    surface: '#1a1a19', primary: '#ffffff', secondary: '#c3c2b7', grid: '#3a3a37',
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
    `.seg { stroke: ${t.surface}; }`,
    `.inbar { fill: ${t.surface}; }`,
    '.inbar-dark { fill: #0b0b0b; }',
    `.self { stroke: ${t.secondary}; }`,
    ...t.series.map((c, k) => `.s${k + 1} { fill: ${c}; }`),
    // Radar series: translucent area, solid outline and points.
    ...t.series.map((c, k) => `.ra${k + 1} { fill: ${c}; stroke: ${c}; } .rp${k + 1} { fill: ${c}; stroke: ${t.surface}; }`),
    `.grid { stroke: ${t.grid}; }`,
    ...t.series.map((c, k) => `.ln${k + 1} { stroke: ${c}; }`),
    `.target, .key { stroke: ${t.secondary}; }`,
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
.grid { fill: none; stroke-width: 1; }
.area { fill-opacity: 0.12; stroke-width: 2; stroke-linejoin: round; }
.point { stroke-width: 2; }
.trend { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.projected { stroke-dasharray: 5 5; }
.target { stroke-dasharray: 3 4; stroke-width: 1.5; }
.hit { fill: transparent; }
.seg { stroke-width: 2; }
.inbar, .inbar-dark { font-family: ${FONT}; font-size: 11px; font-weight: 600; }
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

// --- Bars: share of all lines held by each principal owner -------------------

const OWNER_BARS = 10;

export function ownerSharesSvg(stats) {
  const owners = stats.owners.filter((o) => o.owner).slice(0, OWNER_BARS);
  if (!owners.length) return null;
  const held = owners.reduce((s, o) => s + o.lines, 0);
  const rows = [
    ...owners.map((o) => ({ cls: 's1', label: o.owner.name, lines: o.lines })),
    { cls: 'other', label: 'Everyone else', lines: stats.total - held },
  ];
  const width = 760;
  const rowH = 30;
  const top = 92;
  const labelW = 210;
  const barX = 24 + labelW;
  const barW = width - barX - 90;
  const max = Math.max(...rows.map((r) => r.lines), 1);
  const height = top + rows.length * rowH + 24;
  const parts = [
    `<text class="title" x="24" y="40">Share of lines by owner</text>`,
    `<text class="subtitle" x="24" y="62">Share of ${stats.total.toLocaleString('en-US')} lines held by the top ${owners.length} owners</text>`,
  ];
  rows.forEach((r, k) => {
    const y = top + k * rowH;
    const w = Math.max(2, (r.lines / max) * barW);
    const label = r.label.length > 28 ? `${r.label.slice(0, 27)}…` : r.label;
    parts.push(
      `<text class="label" x="${24 + labelW - 12}" y="${y + 15}" text-anchor="end">${esc(label)}</text>`,
      `<rect class="${r.cls}" x="${barX}" y="${y + 3}" width="${w.toFixed(1)}" height="${rowH - 10}" rx="4"><title>${esc(`${r.label}: ${r.lines.toLocaleString('en-US')} lines (${pct(r.lines, stats.total)})`)}</title></rect>`,
      `<text class="muted" x="${(barX + w + 8).toFixed(1)}" y="${y + 15}">${pct(r.lines, stats.total)}</text>`,
    );
  });
  return svgDoc(width, height, parts);
}

// --- Stacked bars: what the principal owners own -----------------------------

const COMPOSITION_OWNERS = 8;
const KINDS = [
  { key: 'code', label: 'code', cls: 's1' },
  { key: 'blank', label: 'blank lines', cls: 's2' },
  // Light segment: dark text inside it, for contrast.
  { key: 'punctuation', label: 'punctuation only', cls: 's4', ink: 'inbar-dark' },
  { key: 'binary', label: 'binary files', cls: 's3' },
];

export function compositionSvg(stats) {
  const owners = stats.owners.filter((o) => o.owner && o.composition).slice(0, COMPOSITION_OWNERS);
  if (!owners.length) return null;
  const kinds = KINDS.filter((k) => owners.some((o) => o.composition[k.key] > 0));
  const width = 760;
  const rowH = 34;
  const top = 116;
  const labelW = 190;
  const barX = 24 + labelW;
  const barW = width - barX - 96;
  const height = top + owners.length * rowH + 20;
  const parts = [
    `<text class="title" x="24" y="40">What the principal owners own</text>`,
    `<text class="subtitle" x="24" y="62">Lines owned by each of the top ${owners.length} owners, by kind of line</text>`,
  ];
  let lx = 24;
  for (const k of kinds) {
    parts.push(`<rect class="${k.cls}" x="${lx}" y="78" width="12" height="12" rx="3"/>`, `<text class="label" x="${lx + 18}" y="89">${k.label}</text>`);
    lx += 18 + k.label.length * 7 + 22;
  }
  owners.forEach((o, i) => {
    const y = top + i * rowH;
    const total = kinds.reduce((s, k) => s + o.composition[k.key], 0);
    const name = o.owner.name.length > 26 ? `${o.owner.name.slice(0, 25)}…` : o.owner.name;
    parts.push(`<text class="label" x="${barX - 12}" y="${y + 17}" text-anchor="end">${esc(name)}</text>`);
    let x = barX;
    for (const k of kinds) {
      const n = o.composition[k.key];
      if (!n) continue;
      const w = (n / total) * barW;
      parts.push(`<rect class="${k.cls} seg" x="${x.toFixed(1)}" y="${y + 3}" width="${w.toFixed(1)}" height="${rowH - 10}"><title>${esc(`${o.owner.name}, ${k.label}: ${n.toLocaleString('en-US')} lines (${pct(n, total)} of their lines)`)}</title></rect>`);
      if (w >= 40) parts.push(`<text class="${k.ink ?? 'inbar'}" x="${(x + w / 2).toFixed(1)}" y="${y + 19}" text-anchor="middle">${pct(n, total)}</text>`);
      x += w;
    }
    parts.push(`<text class="muted" x="${barX + barW + 10}" y="${y + 19}">${total.toLocaleString('en-US')}</text>`);
  });
  return svgDoc(width, height, parts);
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

// --- Radar ("spider") charts --------------------------------------------------

// Three series at most: overlapping areas need the palette slots that stay
// distinguishable all-pairs (see the dataviz palette notes), and a radar with
// more is unreadable anyway.
const RADAR_SERIES = 3;

// axes: [{ label }]; series: [{ name, values: [0..1 per axis], raw: [text per axis] }]
export function radarSvg({ title, subtitle, axes, series }) {
  series = series.slice(0, RADAR_SERIES);
  // Room for axis labels on both sides (up to about 34 characters).
  const width = 800;
  const cx = 400;
  const cy = 300;
  const r = 170;
  const n = axes.length;
  const angle = (i) => -Math.PI / 2 + (2 * Math.PI * i) / n;
  const at = (i, v) => [cx + r * v * Math.cos(angle(i)), cy + r * v * Math.sin(angle(i))];
  const pts = (vals) => vals.map((v, i) => at(i, v).map((x) => x.toFixed(1)).join(',')).join(' ');

  const parts = [
    `<text class="title" x="24" y="40">${esc(title)}</text>`,
    `<text class="subtitle" x="24" y="62">${esc(subtitle)}</text>`,
  ];
  for (const ring of [0.25, 0.5, 0.75, 1]) {
    parts.push(`<polygon class="grid" points="${pts(axes.map(() => ring))}"/>`);
  }
  axes.forEach((a, i) => {
    const [x, y] = at(i, 1);
    parts.push(`<line class="grid" x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/>`);
    const [lx, ly] = at(i, 1.12);
    const anchor = Math.abs(lx - cx) < 8 ? 'middle' : lx > cx ? 'start' : 'end';
    parts.push(`<text class="axis" x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}" text-anchor="${anchor}">${esc(a.label)}</text>`);
  });
  series.forEach((s, k) => {
    parts.push(`<polygon class="area ra${k + 1}" points="${pts(s.values)}"><title>${esc(s.name)}</title></polygon>`);
  });
  series.forEach((s, k) => {
    s.values.forEach((v, i) => {
      const [x, y] = at(i, v);
      parts.push(`<circle class="point rp${k + 1}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.5"><title>${esc(`${s.name}, ${axes[i].label}: ${s.raw[i]}`)}</title></circle>`);
    });
  });
  // Legend, one row below the chart.
  let lx = 24;
  const ly = cy + r + 70;
  series.forEach((s, k) => {
    parts.push(`<rect class="s${k + 1}" x="${lx}" y="${ly - 11}" width="12" height="12" rx="3"/>`);
    parts.push(`<text class="label" x="${lx + 20}" y="${ly}">${esc(s.name)}</text>`);
    lx += 20 + s.name.length * 7.5 + 28;
  });
  return svgDoc(width, ly + 30, parts);
}

// --- Line chart with projection ------------------------------------------------

// quarters: x values (integers) for the history part; series: [{ name, values
// (same length as quarters), projection: [{ q, v }] | null }]; yMax: top of the
// axis; yFormat: tick label; target: { value, label } | null. xTick returns the
// label for an x value, or null for no tick (default: the year, at each Q1);
// xFormat names an x value in tooltips; nowLine marks the last x value.
const yearTick = (q) => (q % 4 === 0 ? String(Math.floor(q / 4)) : null);
const quarterName = (q) => `${Math.floor(q / 4)} Q${(q % 4) + 1}`;

export function trendSvg({ title, subtitle, quarters, series, yMax, yFormat, target = null, label, xTick = yearTick, xFormat = quarterName, nowLine = true }) {
  const width = 800;
  const height = 420;
  const left = 72;
  const right = 170;
  const top = 92;
  const bottom = 56;
  const q0 = quarters[0];
  const q1 = Math.max(quarters[quarters.length - 1], ...series.flatMap((s) => (s.projection ?? []).map((p) => p.q)));
  const x = (q) => left + ((q - q0) / Math.max(1, q1 - q0)) * (width - left - right);
  const y = (v) => top + (1 - Math.min(Math.max(v / yMax, 0), 1)) * (height - top - bottom);
  const path = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'} ${x(p.q).toFixed(1)} ${y(p.v).toFixed(1)}`).join(' ');

  const parts = [
    `<text class="title" x="24" y="40">${esc(title)}</text>`,
    `<text class="subtitle" x="24" y="62">${esc(subtitle)}</text>`,
  ];
  for (const f of [0, 0.25, 0.5, 0.75, 1]) {
    const v = yMax * f;
    parts.push(`<line class="grid" x1="${left}" x2="${width - right}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`);
    parts.push(`<text class="muted" x="${left - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${esc(yFormat(v))}</text>`);
  }
  for (let q = q0; q <= q1; q++) {
    const tick = xTick(q);
    if (tick === null) continue;
    parts.push(`<text class="muted" x="${x(q).toFixed(1)}" y="${height - bottom + 20}" text-anchor="middle">${esc(tick)}</text>`);
  }
  if (nowLine) {
    const now = quarters[quarters.length - 1];
    parts.push(`<line class="grid" x1="${x(now).toFixed(1)}" x2="${x(now).toFixed(1)}" y1="${top}" y2="${height - bottom}"/>`);
    parts.push(`<text class="muted" x="${(x(now) + 4).toFixed(1)}" y="${height - bottom - 6}">${esc(label ?? 'now')}</text>`);
  }
  if (target) {
    parts.push(`<line class="target" x1="${left}" x2="${width - right}" y1="${y(target.value).toFixed(1)}" y2="${y(target.value).toFixed(1)}"/>`);
    parts.push(`<text class="muted" x="${width - right + 8}" y="${(y(target.value) + 4).toFixed(1)}">${esc(target.label)}</text>`);
  }
  series.forEach((s, k) => {
    // A series may be shorter than quarters (it ends where its data ends).
    const pts = quarters.map((q, i) => ({ q, v: s.values[i] })).filter((p) => p.v !== undefined && p.v !== null);
    parts.push(`<path class="trend ln${k + 1}" d="${path(pts)}"/>`);
    if (s.projection) parts.push(`<path class="trend projected ln${k + 1}" d="${path(s.projection)}"/>`);
    for (const p of pts) {
      parts.push(`<circle class="hit" cx="${x(p.q).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="6"><title>${esc(`${s.name}, ${xFormat(p.q)}: ${yFormat(p.v)}`)}</title></circle>`);
    }
    const last = pts[pts.length - 1];
    parts.push(`<circle class="point rp${k + 1}" cx="${x(last.q).toFixed(1)}" cy="${y(last.v).toFixed(1)}" r="4.5"/>`);
  });
  // Legend under the plot.
  let lx = left;
  const ly = height - 12;
  series.forEach((s, k) => {
    parts.push(`<line class="trend ln${k + 1}" x1="${lx}" x2="${lx + 18}" y1="${ly - 4}" y2="${ly - 4}"/>`);
    parts.push(`<text class="label" x="${lx + 24}" y="${ly}">${esc(s.name)}</text>`);
    lx += 24 + s.name.length * 7.5 + 28;
  });
  if (series.some((s) => s.projection)) {
    parts.push(`<line class="trend projected key" x1="${lx}" x2="${lx + 18}" y1="${ly - 4}" y2="${ly - 4}"/>`);
    parts.push(`<text class="muted" x="${lx + 24}" y="${ly}">projection</text>`);
  }
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

// Characters XML does not allow (C0 controls other than tab and newlines,
// U+FFFE/U+FFFF, unpaired surrogates) come from author names and line text;
// left in, they make the standalone SVG files ill-formed. Shown as U+FFFD.
const XML_INVALID = /[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function esc(s) {
  return String(s).replace(XML_INVALID, '\uFFFD').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
