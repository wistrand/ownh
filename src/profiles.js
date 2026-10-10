// Data for the report's radar ("spider") charts, derived from collectStats
// output only.
import { share } from './stats.js';

const PROFILE_SIZE = 3;

// The top owners on six axes. Each axis is normalized to the highest value among
// the owners shown, so the outer ring is "the most of anyone on this chart".
export function ownerProfile(stats) {
  const top = stats.owners.filter((o) => o.owner).slice(0, PROFILE_SIZE);
  const rows = top.map((o) => {
    let reach = 0;
    let absentee = 0;
    let topIn = 0;
    for (const r of stats.repos) {
      const entry = r.owners.find((x) => x.identityId === o.identityId);
      if (!entry) continue;
      reach++;
      if (!entry.contributor) absentee += entry.lines;
      if (r.owners.find((x) => x.owner)?.identityId === o.identityId) topIn++;
    }
    return {
      name: o.owner.name,
      metrics: [o.lines, o.commits, reach, absentee, o.commits ? o.lines / o.commits : 0, topIn],
    };
  });
  const axes = [
    { label: 'Lines owned', fmt: num },
    { label: 'Commits', fmt: num },
    { label: 'Repositories reached', fmt: num },
    { label: 'Lines owned where never committed', fmt: num },
    { label: 'Lines per commit', fmt: (v) => num(Math.round(v)) },
    { label: 'Repositories led', fmt: num },
  ];
  const max = axes.map((_, i) => Math.max(0, ...rows.map((r) => r.metrics[i])));
  return {
    title: 'Ownership profile: principal owners',
    subtitle: 'Each axis normalized to the highest value among the owners shown',
    axes,
    series: rows.map((r) => ({
      name: r.name,
      values: r.metrics.map((v, i) => (max[i] > 0 ? v / max[i] : 0)),
      raw: r.metrics.map((v, i) => axes[i].fmt(v)),
    })),
  };
}

// The largest repositories on five shares (0 to 100%), so no normalization.
export function repoProfile(stats) {
  const top = [...stats.repos].sort((a, b) => b.lines - a.lines || (a.name < b.name ? -1 : 1)).slice(0, PROFILE_SIZE);
  const axes = [
    { label: 'Top owner, line hash' },
    { label: 'Top owner, git blame' },
    { label: 'Top committer' },
    { label: 'Written in another repository' },
    { label: 'Owned by non-contributors' },
  ];
  return {
    title: 'Governance profile: largest repositories',
    subtitle: 'Share of each repository, 0 to 100%',
    axes,
    series: top.map((r) => {
      const m = r.methods ?? {};
      const values = [
        m.hash?.share ?? 0,
        m.blame?.share ?? 0,
        m.commits?.share ?? 0,
        share(r.foreign, r.lines),
        share(r.absentee, r.lines),
      ];
      const raw = values.map((v) => `${(v * 100).toFixed(1)}%`);
      if (!m.blame) raw[1] = 'not computed';
      return { name: r.name, values, raw };
    }),
  };
}

function num(n) {
  return Number(n).toLocaleString('en-US');
}

