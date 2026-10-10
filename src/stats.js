import { QUARTER_SQL, buildTimeline } from './timeline.js';
import { deletions, hasChurn, netByQuarter, survival } from './churn.js';
import { declaredOwnership } from './codeowners.js';
import { blameCounts } from './blamecounts.js';
import { headPass, topLineCounts } from './head.js';
import { compareNullLast, rankOwners, share, topOf } from './rank.js';
import { codeHash, stageCache } from './stagecache.js';

export { share } from './rank.js';

// Every number shown by `summary` and `report` comes from collectStats, so the
// text summary and the report files can't disagree.
//
// The expensive passes are stages, each cached under its own key by `cache`
// (see stagecache.js); everything in this file only combines their results
// and is recomputed on every run. A stage's code key covers its module and the
// modules it imports, computed here, once, when this module loads.
const CODE = {
  head: codeHash(new URL('./head.js', import.meta.url)),
  blame: codeHash(new URL('./blamecounts.js', import.meta.url)),
  declared: codeHash(new URL('./codeowners.js', import.meta.url)),
  churn: codeHash(new URL('./churn.js', import.meta.url)),
};

// What a stage's data key covers. `index`: every completed index or add run
// (any change to history, head lines, or identities makes a new run row).
// `blame`: blamed files and sample settings (blame writes nothing else that a
// stage reads, apart from names of identities only blame knows).
function fingerprints(db) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name));
  return {
    index: db.prepare('SELECT id, finished_at FROM runs WHERE finished_at IS NOT NULL ORDER BY id').all(),
    blame: tables.has('blame_files')
      ? {
        files: db.prepare('SELECT COUNT(*) AS n FROM blame_files').get().n,
        repos: tables.has('blame_repos') ? db.prepare('SELECT repo_id, sample FROM blame_repos ORDER BY repo_id').all() : [],
      }
      : null,
  };
}

// `log` receives progress messages; the passes over head_lines are the slow part.
// `cache` is a stageCache; without one every stage is computed.
export function collectStats(db, { topLines = 10, log = () => {}, cache = stageCache(null) } = {}) {
  const run = db.prepare('SELECT tool_version, excludes FROM runs ORDER BY id DESC LIMIT 1').get();
  const repos = db.prepare('SELECT id, name, path, head FROM repos ORDER BY name').all();
  const repoName = new Map(repos.map((r) => [r.id, r.name]));
  const identities = new Map(
    db.prepare('SELECT id, name, email FROM identities').all().map((i) => [i.id, { name: i.name, email: i.email }]),
  );
  const fp = fingerprints(db);
  // Merges are walked but are not commits for counting (commit totals, the
  // commits method); databases built before merges were walked have no is_merge
  // column and only non-merge commits. For activity (who worked in a repo, who
  // is inactive, "now") a merge counts: its author may own lines through it.
  const commitColumns = new Set(db.prepare("SELECT name FROM pragma_table_info('commits')").all().map((c) => c.name));
  const NON_MERGE = commitColumns.has('is_merge') ? 'WHERE is_merge = 0' : '';

  // (repo, identity) pairs with at least one commit, merges included: who has
  // ever worked in a repo.
  const contributed = new Set(
    db.prepare('SELECT DISTINCT repo_id, identity_id FROM commits').all().map((r) => `${r.repo_id}:${r.identity_id}`),
  );

  const head = cache.run('head', { code: CODE.head, data: fp.index }, () => headPass(db, repos, log));
  const byRepo = new Map(repos.map((r) => [r.id, {
    name: r.name, lines: 0, foreign: 0, absentee: 0, owners: new Map(), origins: new Map(),
  }]));
  const overall = new Map();
  let total = 0;
  // Surviving lines by (repo, owner, quarter first written): input to the timeline.
  const cohorts = [];
  for (const { repoId, identityId, originId, q, n } of head.rows) {
    if (identityId !== null) cohorts.push({ repoId, identityId, q, n });
    const repo = byRepo.get(repoId);
    repo.lines += n;
    if (originId !== null && originId !== repoId) repo.foreign += n;
    if (identityId !== null && !contributed.has(`${repoId}:${identityId}`)) repo.absentee += n;
    repo.owners.set(identityId, (repo.owners.get(identityId) ?? 0) + n);
    repo.origins.set(originId, (repo.origins.get(originId) ?? 0) + n);
    overall.set(identityId, (overall.get(identityId) ?? 0) + n);
    total += n;
  }

  const lines = cache.run('lines', { code: CODE.head, data: fp.index, args: { topLines } }, () => topLineCounts(db, topLines, log))
    .map(({ identityId, ...l }) => ({ ...l, owner: identityId === null ? null : identities.get(identityId) ?? null }));

  const blame = cache.run('blame', { code: CODE.blame, data: [fp.index, fp.blame] }, () => blameCounts(db, repos, head.paths, log));
  const methods = collectMethods(db, repos, head.paths, blame, byRepo, overall, identities, NON_MERGE);

  // Declared ownership (CODEOWNERS at the stored head) next to the computed
  // answers. Blame per rule only for fully blamed repos: a sample covers too few
  // files per rule.
  const declared = cache.run('declared', { code: CODE.declared, data: [fp.index, fp.blame] }, () => {
    const out = {};
    for (const r of repos) {
      const d = declaredOwnership(db, r, { blameFull: blame[r.id].kind === 'full', identities });
      if (d) log(`declared: ${r.name} (${d.file}, ${d.rules.length} rules with lines)`);
      out[r.id] = d;
    }
    return out;
  });

  // Non-merge commits per identity across all repos, shown next to line counts.
  const commitsBy = new Map(db.prepare(`SELECT identity_id AS id, COUNT(*) AS n FROM commits ${NON_MERGE} GROUP BY identity_id`).all().map((r) => [r.id, r.n]));

  const ranked = rankOwners(overall, identities);
  const churn = hasChurn(db);
  // With churn data the timeline is a true history (lines added minus removed);
  // without it, the surviving lines grouped by when they were first written.
  const history = churn ? cache.run('history', { code: CODE.churn, data: fp.index }, () => netByQuarter(db, log)) : null;
  const timeline = buildTimeline({
    cohorts: history ?? cohorts,
    mode: history ? 'history' : 'cohort',
    // All commits, merges included: activity, and "now", which must not be
    // older than any line's quarter (a merge can land after its branch).
    commitQuarters: db.prepare(`SELECT identity_id AS identityId, ${QUARTER_SQL('author_time')} AS q FROM commits GROUP BY identity_id, q`).all(),
    blankByQuarter: commitColumns.has('added_blank')
      ? db.prepare(`SELECT ${QUARTER_SQL('author_time')} AS q, SUM(added_blank) AS n FROM commits GROUP BY q`).all()
      : null,
    contributed,
    principal: ranked.find((o) => o.owner) ?? null,
  });
  if (timeline) timeline.headLines = total;

  // Newest commit per author (unix seconds), merges included, for activity checks.
  const lastCommitBy = new Map(db.prepare('SELECT identity_id AS id, MAX(author_time) AS t FROM commits GROUP BY identity_id').all().map((r) => [r.id, r.t]));

  // Lines written (added, including hand-written merge lines) per author.
  const writtenBy = commitColumns.has('added_lines')
    ? new Map(db.prepare('SELECT identity_id AS id, SUM(added_lines) AS n FROM commits GROUP BY identity_id').all().map((r) => [r.id, r.n]))
    : null;

  let removal = null;
  let removedOthersBy = null;
  let survivalCurves = null;
  if (churn) {
    const { removedOthersBy: pairs, ...rest } = cache.run('deletions', { code: CODE.churn, data: fp.index }, () => deletions(db, identities, log));
    removal = rest;
    removedOthersBy = new Map(pairs);
    const top = ranked.filter((o) => o.owner).slice(0, 3);
    const groups = top.map((o) => o.identityId);
    const now = timeline ? timeline.now : 0;
    const curves = cache.run('survival', { code: CODE.churn, data: fp.index, args: { groups, now } }, () => survival(db, groups, now, log));
    survivalCurves = {
      all: curves.all,
      owners: top.map((o) => ({ owner: o.owner, ...curves[o.identityId] })),
    };
  }

  return {
    toolVersion: run.tool_version,
    excludes: JSON.parse(run.excludes),
    total,
    timeline,
    deletions: removal,
    survival: survivalCurves,
    owners: ranked.map((o) => ({
      ...o,
      commits: o.identityId === null ? 0 : (commitsBy.get(o.identityId) ?? 0),
      written: o.identityId === null || !writtenBy ? null : (writtenBy.get(o.identityId) ?? 0),
      lastCommit: o.identityId === null ? null : (lastCommitBy.get(o.identityId) ?? null),
      // Lines owned by someone else that this owner removed; null without churn.
      removedOthers: o.identityId === null || !removedOthersBy ? null : (removedOthersBy.get(o.identityId) ?? 0),
    })),
    lines,
    methods: methods.overall,
    repos: [...byRepo].map(([id, r]) => ({
      name: r.name,
      methods: methods.byRepo.get(id),
      declared: declared[id],
      lines: r.lines,
      // Lines owned through a line first written in another repo.
      foreign: r.foreign,
      // Lines owned by someone with no commits in this repo.
      absentee: r.absentee,
      owners: rankOwners(r.owners, identities).map((o) => ({
        ...o,
        contributor: o.owner !== null && contributed.has(`${id}:${o.identityId}`),
      })),
      // Where this repo's lines were first written; null = unattributed.
      origins: [...r.origins]
        .map(([originId, n]) => ({ repo: originId === null ? null : repoName.get(originId), lines: n }))
        .sort((a, b) => b.lines - a.lines || compareNullLast(a.repo, b.repo)),
    })),
  };
}

// Three answers to "who owns this repo": most commits, most lines by
// `git blame`, most lines by line hash (OWNH). Blame needs `ownh blame` to have
// run; its counts come from the blame stage (blamecounts.js). A fully blamed
// repo gives exact counts; a sampled repo gives an estimate (blameEstimate).
// The overall blame answer needs every repo and is an estimate when any repo
// was sampled.
function collectMethods(db, repos, paths, blame, byRepo, overall, identities, NON_MERGE) {
  const commits = new Map(repos.map((r) => [r.id, new Map()]));
  const allCommits = new Map();
  for (const { repoId, identityId, n } of db.prepare(
    `SELECT repo_id AS repoId, identity_id AS identityId, COUNT(*) AS n FROM commits ${NON_MERGE} GROUP BY repo_id, identity_id`,
  ).all()) {
    commits.get(repoId).set(identityId, n);
    allCommits.set(identityId, (allCommits.get(identityId) ?? 0) + n);
  }

  // Overall blame: exact counts from full repos plus expanded sample counts.
  const allBlame = new Map();
  let allBlameTotal = 0;
  let blameComplete = true;
  let blameEstimated = false;

  const result = new Map();
  for (const r of repos) {
    const b = blame[r.id];
    let top = null;
    if (b.kind === 'full') {
      const counts = new Map(b.counts);
      for (const [id, n] of counts) {
        allBlame.set(id, (allBlame.get(id) ?? 0) + n);
        allBlameTotal += n;
      }
      top = topOf(counts, identities);
    } else if (b.kind === 'sample') {
      const est = blameEstimate(b.files.map((f) => new Map(f)), paths[r.id].length, identities);
      for (const [id, n] of est.expanded) allBlame.set(id, (allBlame.get(id) ?? 0) + n);
      allBlameTotal += est.expandedTotal;
      blameEstimated = true;
      top = est.top;
    } else {
      blameComplete = false;
    }
    const m = {
      commits: topOf(commits.get(r.id), identities),
      blame: top,
      hash: topOf(byRepo.get(r.id).owners, identities),
      blamedFiles: b.done,
      files: paths[r.id].length,
    };
    m.agree = agree(m);
    result.set(r.id, m);
  }
  let overallBlame = null;
  if (blameComplete) {
    overallBlame = topOf(allBlame, identities, allBlameTotal);
    if (overallBlame && blameEstimated) overallBlame.estimate = { margin: null };
  }
  const all = {
    commits: topOf(allCommits, identities),
    blame: overallBlame,
    hash: topOf(overall, identities),
  };
  all.agree = agree(all);
  return { byRepo: result, overall: all };
}

// Blame ownership of a repo estimated from a simple random sample of n of its N
// files. The share of owner o is the ratio estimator R = sum(y_i) / sum(x_i)
// over sampled files (y_i = o's blamed lines in file i, x_i = blamed lines in
// file i). Its 95% margin uses the standard ratio-estimator variance with the
// finite population correction:
//   SE(R) = sqrt((1 - n/N) * sum((y_i - R x_i)^2) / (n - 1) / n) / mean(x)
// Files, not lines, are the sampling unit, so the margin accounts for the
// clustering of lines within files. `files` holds one Map(identity -> lines)
// per sampled file.
function blameEstimate(files, totalFiles, identities) {
  const totals = new Map();
  let x = 0;
  for (const f of files) {
    for (const [id, n] of f) {
      totals.set(id, (totals.get(id) ?? 0) + n);
      x += n;
    }
  }
  const top = topOf(totals, identities);
  const n = files.length;
  const expand = totalFiles / n;
  const expanded = new Map([...totals].map(([id, y]) => [id, y * expand]));
  if (!top) return { top: null, expanded, expandedTotal: x * expand };

  const R = top.share;
  let ss = 0;
  for (const f of files) {
    const xi = [...f.values()].reduce((a, b) => a + b, 0);
    const yi = f.get(top.identityId) ?? 0;
    ss += (yi - R * xi) ** 2;
  }
  const meanX = x / n;
  const se = n > 1 && meanX > 0 ? Math.sqrt(((1 - n / totalFiles) * ss) / (n - 1) / n) / meanX : 0;
  top.estimate = { files: n, ofFiles: totalFiles, margin: 1.96 * se };
  return { top, expanded, expandedTotal: x * expand };
}

// True when every method that has an answer names the same person.
function agree(m) {
  const emails = [m.commits, m.blame, m.hash].filter(Boolean).map((t) => t.owner.email);
  return emails.length > 1 && emails.every((e) => e === emails[0]);
}

export function pct(n, total) {
  return `${(share(n, total) * 100).toFixed(1)}%`;
}

// Share text for one method's answer: "31.2%", or "~31.2% ±2.1" for a sampled
// blame estimate (margin in percentage points; overall estimates have none).
export function methodShare(t) {
  if (!t.estimate) return pct(t.count, t.total);
  const margin = t.estimate.margin === null ? '' : ` ±${(t.estimate.margin * 100).toFixed(1)}`;
  return `~${(t.share * 100).toFixed(1)}%${margin}`;
}

export const UNATTRIBUTED = '(unattributed)';

export function ownerLabel(owner) {
  return owner ? `${owner.name} <${owner.email}>` : UNATTRIBUTED;
}

export function lineLabel(line, max = 50) {
  if (line.binary === null) return UNATTRIBUTED;
  const s = line.binary ? `(binary) ${line.path}` : JSON.stringify(line.text);
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

// Column width for text tables: user-perceived characters, not UTF-16 units,
// so a name stored with a combining mark ("o" + U+0308) pads like "ö". Names
// are shown as stored, never normalized.
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

export function textWidth(s) {
  let n = 0;
  for (const _ of graphemes.segment(s)) n++;
  return n;
}

export function padText(s, width, right = false) {
  const fill = ' '.repeat(Math.max(0, width - textWidth(s)));
  return right ? fill + s : s + fill;
}
