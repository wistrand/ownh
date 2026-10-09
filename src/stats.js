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
  // (repo, identity) pairs with at least one commit: who has ever worked in a repo.
  const contributed = new Set(
    db.prepare('SELECT DISTINCT repo_id, identity_id FROM commits').all().map((r) => `${r.repo_id}:${r.identity_id}`),
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
    SELECT c.identity_id AS identityId, l.repo_id AS originId, COUNT(*) AS n
    ${OWNER_JOIN}
    WHERE h.repo_id = ? AND h.path >= ? AND (? IS NULL OR h.path < ?)
    GROUP BY c.identity_id, l.repo_id
  `);
  const rows = [];
  repos.forEach((r, k) => {
    const chunks = pathChunks(db, r.id);
    chunks.forEach(([from, to], c) => {
      for (const row of ownersOf.all(r.id, from, to, to)) rows.push({ repoId: r.id, ...row });
      const part = chunks.length > 1 ? ` part ${c + 1}/${chunks.length}` : '';
      log(`owners: ${k + 1}/${repos.length} repos (${r.name}${part}), ${elapsed()}`);
    });
  });
  for (const { repoId, identityId, originId, n } of rows) {
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

  return {
    toolVersion: run.tool_version,
    excludes: JSON.parse(run.excludes),
    total,
    owners: rankOwners(overall, identities),
    lines,
    repos: [...byRepo].map(([id, r]) => ({
      name: r.name,
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

// Splits a repo's head lines into path ranges of about CHUNK_LINES lines, so a
// large repo reports progress while it is aggregated. Returns [from, to) pairs;
// `to` is null for the last range. Rows in different ranges are summed later, so
// the split doesn't change any number.
const CHUNK_LINES = 1_000_000;

function pathChunks(db, repoId) {
  const chunks = [];
  let from = '';
  let size = 0;
  for (const { path, n } of db.prepare('SELECT path, COUNT(*) AS n FROM head_lines WHERE repo_id = ? GROUP BY path').iterate(repoId)) {
    if (size >= CHUNK_LINES) {
      chunks.push([from, path]);
      from = path;
      size = 0;
    }
    size += n;
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

export const UNATTRIBUTED = '(unattributed)';

export function ownerLabel(owner) {
  return owner ? `${owner.name} <${owner.email}>` : UNATTRIBUTED;
}

export function lineLabel(line, max = 50) {
  if (line.binary === null) return UNATTRIBUTED;
  const s = line.binary ? `(binary) ${line.path}` : JSON.stringify(line.text);
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}
