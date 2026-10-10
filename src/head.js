// The passes over head_lines that collectStats caches as stages (see
// stagecache.js). They return plain, JSON-safe data; stats.js combines it.
import { QUARTER_SQL } from './quarters.js';

// Head lines whose hash no analyzed commit ever added (for example, lines from
// an octopus merge, which remerge cannot redo) have no owner and no origin
// repo: identity and origin are null. Lines written while resolving a merge are
// owned by the merge's author.
const OWNER_JOIN = `
FROM head_lines h
LEFT JOIN line_hashes l ON l.hash = h.hash
LEFT JOIN commits c ON c.id = l.commit_id
`;

// One pass over all head lines, grouped by repo, owner, origin repo (where the
// owning line was first written), and quarter first written. Run per repo in
// path ranges, which costs the same (head_lines is keyed by repo and path) and
// lets progress be reported. Returns { rows, paths }: rows of { repoId,
// identityId, originId, q, n }, and each repo's head paths (by repo id).
export function headPass(db, repos, log = () => {}) {
  const started = Date.now();
  const ownersOf = db.prepare(`
    SELECT c.identity_id AS identityId, l.repo_id AS originId, ${QUARTER_SQL('l.author_time')} AS q, COUNT(*) AS n
    ${OWNER_JOIN}
    WHERE h.repo_id = ? AND h.path >= ? AND (? IS NULL OR h.path < ?)
    GROUP BY c.identity_id, l.repo_id, q
  `);
  const rows = [];
  const paths = {};
  repos.forEach((r, k) => {
    const chunks = pathChunks(db, r.id);
    paths[r.id] = chunks.paths;
    chunks.forEach(([from, to], c) => {
      for (const row of ownersOf.all(r.id, from, to, to)) rows.push({ repoId: r.id, ...row });
      const part = chunks.length > 1 ? ` part ${c + 1}/${chunks.length}` : '';
      log(`owners: ${k + 1}/${repos.length} repos (${r.name}${part}), ${((Date.now() - started) / 1000).toFixed(1)}s`);
    });
  });
  return { rows, paths };
}

// The `topLines` most frequent hashes at head, with the details of their
// owning introduction. Counted per hash first (index-only on head_lines_hash),
// in 16 ranges by the first hex digit for progress; each hash is in exactly one
// range, so the global top N is the top N of the per-range top N lists. Owners
// are identity ids.
export function topLineCounts(db, topLines, log = () => {}) {
  const started = Date.now();
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
    for (const row of countRange.iterate(digits[d], to, to, topLines)) candidates.push(row);
    log(`top lines: ${d + 1}/${digits.length} hash ranges, ${((Date.now() - started) / 1000).toFixed(1)}s`);
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
  return candidates.map(({ hash, n }) => {
    const r = detail.get(hash);
    return r
      ? { text: r.text, binary: Boolean(r.binary), path: r.path, lines: n, identityId: r.identityId, origin: r.origin }
      : { text: null, binary: null, path: null, lines: n, identityId: null, origin: null };
  });
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
