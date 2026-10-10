import { samplePaths } from './sample.js';
import { QUARTER_SQL, buildTimeline } from './timeline.js';
import { deletions, hasChurn, netByQuarter, survival } from './churn.js';

// Every number shown by `summary` and `report` comes from collectStats, so the
// text summary and the report files can't disagree.

// Head lines whose hash no non-merge commit ever added (for example, lines
// written while resolving a merge conflict) have no owner and no origin repo:
// identity and origin are null.
const OWNER_JOIN = `
FROM head_lines h
LEFT JOIN line_hashes l ON l.hash = h.hash
LEFT JOIN commits c ON c.id = l.commit_id
`;

// `log` receives progress messages; the passes over head_lines are the slow part.
export function collectStats(db, { topLines = 10, log = () => {} } = {}) {
  const started = Date.now();
  const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
  const run = db.prepare('SELECT tool_version, excludes FROM runs ORDER BY id DESC LIMIT 1').get();
  const repos = db.prepare('SELECT id, name FROM repos ORDER BY name').all();
  const repoName = new Map(repos.map((r) => [r.id, r.name]));
  const identities = new Map(
    db.prepare('SELECT id, name, email FROM identities').all().map((i) => [i.id, { name: i.name, email: i.email }]),
  );
  // Merges are walked but are not commits for counting; databases built before
  // merges were walked have no is_merge column and only non-merge commits.
  const commitColumns = new Set(db.prepare("SELECT name FROM pragma_table_info('commits')").all().map((c) => c.name));
  const NON_MERGE = commitColumns.has('is_merge') ? 'WHERE is_merge = 0' : '';

  // (repo, identity) pairs with at least one commit: who has ever worked in a repo.
  const contributed = new Set(
    db.prepare(`SELECT DISTINCT repo_id, identity_id FROM commits ${NON_MERGE}`).all().map((r) => `${r.repo_id}:${r.identity_id}`),
  );

  // One pass over all head lines, grouped by repo, owner, and origin repo (the
  // repo where the owning line was first written). Run per repo, which costs the
  // same (head_lines is keyed by repo) and lets progress be reported.
  const byRepo = new Map(repos.map((r) => [r.id, {
    name: r.name, lines: 0, foreign: 0, absentee: 0, owners: new Map(), origins: new Map(),
  }]));
  const overall = new Map();
  let total = 0;
  const ownersOf = db.prepare(`
    SELECT c.identity_id AS identityId, l.repo_id AS originId, ${QUARTER_SQL('l.author_time')} AS q, COUNT(*) AS n
    ${OWNER_JOIN}
    WHERE h.repo_id = ? AND h.path >= ? AND (? IS NULL OR h.path < ?)
    GROUP BY c.identity_id, l.repo_id, q
  `);
  const rows = [];
  const repoPaths = new Map();
  repos.forEach((r, k) => {
    const chunks = pathChunks(db, r.id);
    repoPaths.set(r.id, chunks.paths);
    chunks.forEach(([from, to], c) => {
      for (const row of ownersOf.all(r.id, from, to, to)) rows.push({ repoId: r.id, ...row });
      const part = chunks.length > 1 ? ` part ${c + 1}/${chunks.length}` : '';
      log(`owners: ${k + 1}/${repos.length} repos (${r.name}${part}), ${elapsed()}`);
    });
  });
  // Surviving lines by (repo, owner, quarter first written): input to the timeline.
  const cohorts = [];
  for (const { repoId, identityId, originId, q, n } of rows) {
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

  // Count head lines per hash first (index-only on head_lines_hash), then look
  // up owner details for the winners only. Split into 16 ranges by the first hex
  // digit for progress; each hash is in exactly one range, so the global top N is
  // the top N of the per-range top N lists.
  const countRange = db.prepare(`
    SELECT hash, COUNT(*) AS n FROM head_lines
    WHERE hash >= ? AND (? IS NULL OR hash < ?)
    GROUP BY hash
    ORDER BY n DESC, hash
    LIMIT ?
  `);
  const digits = '0123456789abcdef';
  let candidates = [];
  for (let d = 0; d < digits.length; d++) {
    const to = d + 1 < digits.length ? digits[d + 1] : null;
    candidates.push(...countRange.all(digits[d], to, to, topLines));
    log(`top lines: ${d + 1}/${digits.length} hash ranges, ${elapsed()}`);
  }
  candidates.sort((a, b) => b.n - a.n || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  candidates = candidates.slice(0, topLines);
  const detail = db.prepare(`
    SELECT l.binary, l.text, l.path, c.identity_id AS identityId, r.name AS origin
    FROM line_hashes l
    JOIN commits c ON c.id = l.commit_id
    JOIN repos r ON r.id = l.repo_id
    WHERE l.hash = ?
  `);
  const lines = candidates.map(({ hash, n }) => {
    const r = detail.get(hash);
    return r
      ? { text: r.text, binary: Boolean(r.binary), path: r.path, lines: n, owner: identities.get(r.identityId) ?? null, origin: r.origin }
      : { text: null, binary: null, path: null, lines: n, owner: null, origin: null };
  });

  log(`top lines: done, ${elapsed()}`);

  const methods = collectMethods(db, repos, repoPaths, byRepo, overall, identities, NON_MERGE, log);

  // Non-merge commits per identity across all repos, shown next to line counts.
  const commitsBy = new Map(db.prepare(`SELECT identity_id AS id, COUNT(*) AS n FROM commits ${NON_MERGE} GROUP BY identity_id`).all().map((r) => [r.id, r.n]));

  const ranked = rankOwners(overall, identities);
  const churn = hasChurn(db);
  // With churn data the timeline is a true history (lines added minus removed);
  // without it, the surviving lines grouped by when they were first written.
  if (churn) log('history: net lines by quarter');
  const history = churn ? netByQuarter(db) : null;
  const timeline = buildTimeline({
    cohorts: history ?? cohorts,
    mode: history ? 'history' : 'cohort',
    commitQuarters: db.prepare(`SELECT identity_id AS identityId, ${QUARTER_SQL('author_time')} AS q FROM commits ${NON_MERGE} GROUP BY identity_id, q`).all(),
    blankByQuarter: commitColumns.has('added_blank')
      ? db.prepare(`SELECT ${QUARTER_SQL('author_time')} AS q, SUM(added_blank) AS n FROM commits GROUP BY q`).all()
      : null,
    contributed,
    principal: ranked.find((o) => o.owner) ?? null,
  });
  if (timeline) timeline.headLines = total;

  // Lines written (added, including hand-written merge lines) per author.
  const writtenBy = commitColumns.has('added_lines')
    ? new Map(db.prepare('SELECT identity_id AS id, SUM(added_lines) AS n FROM commits GROUP BY identity_id').all().map((r) => [r.id, r.n]))
    : null;

  let removal = null;
  let survivalCurves = null;
  if (churn) {
    log('deletions');
    removal = deletions(db, identities);
    log('survival');
    const top = ranked.filter((o) => o.owner).slice(0, 3);
    const curves = survival(db, top.map((o) => o.identityId), timeline ? timeline.now : 0);
    survivalCurves = {
      all: curves.get('all'),
      owners: top.map((o) => ({ owner: o.owner, ...curves.get(o.identityId) })),
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
    })),
    lines,
    methods: methods.overall,
    repos: [...byRepo].map(([id, r]) => ({
      name: r.name,
      methods: methods.byRepo.get(id),
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
// run. A fully blamed repo gives exact counts once every file is done; a sampled
// repo gives an estimate once every file in its sample is done (see
// blameEstimate). The overall blame answer needs every repo and is an estimate
// when any repo was sampled.
function collectMethods(db, repos, repoPaths, byRepo, overall, identities, NON_MERGE, log) {
  const commits = new Map(repos.map((r) => [r.id, new Map()]));
  const allCommits = new Map();
  for (const { repoId, identityId, n } of db.prepare(
    `SELECT repo_id AS repoId, identity_id AS identityId, COUNT(*) AS n FROM commits ${NON_MERGE} GROUP BY repo_id, identity_id`,
  ).all()) {
    commits.get(repoId).set(identityId, n);
    allCommits.set(identityId, (allCommits.get(identityId) ?? 0) + n);
  }

  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name));
  const blamedPaths = tables.has('blame_files') ? db.prepare('SELECT path FROM blame_files WHERE repo_id = ?') : null;
  const settings = new Map(tables.has('blame_repos')
    ? db.prepare('SELECT repo_id AS repoId, sample FROM blame_repos').all().map((r) => [r.repoId, r.sample])
    : []);
  const blameOf = db.prepare(`
    SELECT blame_identity_id AS identityId, COUNT(*) AS n FROM head_lines
    WHERE repo_id = ? AND blame_identity_id IS NOT NULL
    GROUP BY blame_identity_id
  `);
  const blameOfFile = db.prepare(`
    SELECT blame_identity_id AS identityId, COUNT(*) AS n FROM head_lines
    WHERE repo_id = ? AND path = ? AND blame_identity_id IS NOT NULL
    GROUP BY blame_identity_id
  `);
  // Overall blame: exact counts from full repos plus expanded sample counts.
  const allBlame = new Map();
  let allBlameTotal = 0;
  let blameComplete = true;
  let blameEstimated = false;

  const result = new Map();
  for (const r of repos) {
    const paths = repoPaths.get(r.id);
    const done = new Set(blamedPaths ? blamedPaths.all(r.id).map((b) => b.path) : []);
    const sample = settings.get(r.id) ?? null;
    let blame = null;
    if (sample === null && done.size > 0 && paths.every((p) => done.has(p))) {
      const counts = new Map(blameOf.all(r.id).map((b) => [b.identityId, b.n]));
      for (const [id, n] of counts) {
        allBlame.set(id, (allBlame.get(id) ?? 0) + n);
        allBlameTotal += n;
      }
      blame = topOf(counts, identities);
      log(`methods: blame counted for ${r.name}`);
    } else if (sample !== null && samplePaths(paths, sample).every((p) => done.has(p))) {
      const est = blameEstimate(r.id, samplePaths(paths, sample), paths.length, blameOfFile, identities);
      for (const [id, n] of est.expanded) allBlame.set(id, (allBlame.get(id) ?? 0) + n);
      allBlameTotal += est.expandedTotal;
      blameEstimated = true;
      blame = est.top;
      log(`methods: blame estimated for ${r.name} from ${sample} of ${paths.length} files`);
    } else {
      blameComplete = false;
    }
    const m = {
      commits: topOf(commits.get(r.id), identities),
      blame,
      hash: topOf(byRepo.get(r.id).owners, identities),
      blamedFiles: [...done].length,
      files: paths.length,
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
// clustering of lines within files.
function blameEstimate(repoId, sample, totalFiles, blameOfFile, identities) {
  const files = sample.map((path) => new Map(blameOfFile.all(repoId, path).map((b) => [b.identityId, b.n])));
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

// The top attributed owner: { owner, identityId, count, total, share }, or null
// if none. `total` defaults to the sum of counts.
function topOf(counts, identities, total) {
  if (total === undefined) {
    total = 0;
    for (const n of counts.values()) total += n;
  }
  const ranked = rankOwners(counts, identities).filter((o) => o.owner);
  if (ranked.length === 0) return null;
  const t = ranked[0];
  return { owner: t.owner, identityId: t.identityId, count: Math.round(t.lines), total: Math.round(total), share: share(t.lines, total) };
}

// True when every method that has an answer names the same person.
function agree(m) {
  const emails = [m.commits, m.blame, m.hash].filter(Boolean).map((t) => t.owner.email);
  return emails.length > 1 && emails.every((e) => e === emails[0]);
}

// Splits a repo's head lines into path ranges of about CHUNK_LINES lines, so a
// large repo reports progress while it is aggregated. Returns [from, to) pairs;
// `to` is null for the last range. Rows in different ranges are summed later, so
// the split doesn't change any number.
const CHUNK_LINES = 1_000_000;

function pathChunks(db, repoId) {
  const chunks = [];
  chunks.paths = [];
  let from = '';
  let size = 0;
  for (const { path, n } of db.prepare('SELECT path, COUNT(*) AS n FROM head_lines WHERE repo_id = ? GROUP BY path').iterate(repoId)) {
    if (size >= CHUNK_LINES) {
      chunks.push([from, path]);
      from = path;
      size = 0;
    }
    size += n;
    chunks.paths.push(path);
  }
  chunks.push([from, null]);
  return chunks;
}

// Most lines first; ties by email, unattributed last.
function rankOwners(counts, identities) {
  return [...counts]
    .map(([identityId, lines]) => ({ identityId, owner: identities.get(identityId) ?? null, lines }))
    .sort((a, b) => b.lines - a.lines || compareNullLast(a.owner?.email ?? null, b.owner?.email ?? null));
}

function compareNullLast(a, b) {
  if (a === null || b === null) return a === null ? (b === null ? 0 : 1) : -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function share(n, total) {
  return total === 0 ? 0 : n / total;
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
