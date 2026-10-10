// The blame queries collectStats caches as a stage (see stagecache.js): raw
// counts only; the ownership answers and estimates are computed in stats.js.
import { samplePaths } from './sample.js';

// Per repo (keyed by repo id), one of:
//   { kind: 'full', done, counts }    every head file blamed: [[identityId, n]]
//   { kind: 'sample', done, sample, files }  every sampled file blamed: one
//                                     [[identityId, n]] list per sampled file
//   { kind: 'none', done }            blame missing or incomplete
// `done` is the number of blamed files. `paths` are each repo's head paths.
export function blameCounts(db, repos, paths, log = () => {}) {
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
  const out = {};
  for (const r of repos) {
    const all = paths[r.id];
    const done = new Set(blamedPaths ? blamedPaths.all(r.id).map((b) => b.path) : []);
    const sample = settings.get(r.id) ?? null;
    if (sample === null && done.size > 0 && all.every((p) => done.has(p))) {
      out[r.id] = { kind: 'full', done: done.size, counts: blameOf.all(r.id).map((b) => [b.identityId, b.n]) };
      log(`methods: blame counted for ${r.name}`);
    } else if (sample !== null && samplePaths(all, sample).every((p) => done.has(p))) {
      const files = samplePaths(all, sample).map((path) => blameOfFile.all(r.id, path).map((b) => [b.identityId, b.n]));
      out[r.id] = { kind: 'sample', done: done.size, sample, files };
      log(`methods: blame estimated for ${r.name} from ${sample} of ${all.length} files`);
    } else {
      out[r.id] = { kind: 'none', done: done.size };
    }
  }
  return out;
}
