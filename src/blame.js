import { availableParallelism } from 'node:os';
import { openDbForWrite } from './db.js';
import { toPathspecs } from './exclude.js';
import { binaryPaths, blame as gitBlame } from './git.js';

const PROGRESS_INTERVAL_MS = 5000;
// Files per transaction. A run interrupted mid-batch redoes at most this many.
const BATCH_FILES = 200;

// Blame tables are created on demand so .db files built before `ownh blame`
// existed can still be blamed.
const BLAME_SCHEMA = `
CREATE TABLE IF NOT EXISTS blame_files (
  repo_id INTEGER NOT NULL REFERENCES repos (id),
  path    TEXT NOT NULL,
  PRIMARY KEY (repo_id, path)
) WITHOUT ROWID;
`;

// Fills head_lines.blame_identity_id from `git blame` at each repo's stored head.
// Resumable: files already recorded in blame_files are skipped. Binary files are
// skipped (blame has no meaningful lines for them) and recorded as done.
export async function blame({ dbPath, repoNames = [], jobs = availableParallelism(), log = () => {} }) {
  const db = openDbForWrite(dbPath);
  try {
    db.exec(BLAME_SCHEMA);
    const run = db.prepare('SELECT excludes FROM runs ORDER BY id LIMIT 1').get();
    const pathspecs = toPathspecs(JSON.parse(run.excludes));
    let repos = db.prepare('SELECT id, name, path, head FROM repos ORDER BY name').all();
    if (repoNames.length) {
      const known = new Set(repos.map((r) => r.name));
      for (const n of repoNames) if (!known.has(n)) throw new Error(`no repo named "${n}" in ${dbPath}`);
      repos = repos.filter((r) => repoNames.includes(r.name));
    }
    const identityId = identityResolver(db);
    for (const [k, repo] of repos.entries()) {
      await blameRepo(db, repo, pathspecs, identityId, jobs, (msg) => log(`blame ${k + 1}/${repos.length} ${repo.name}: ${msg}`));
    }
  } finally {
    db.close();
  }
}

async function blameRepo(db, repo, pathspecs, identityId, jobs, report) {
  const done = new Set(db.prepare('SELECT path FROM blame_files WHERE repo_id = ?').all(repo.id).map((r) => r.path));
  const all = db.prepare('SELECT DISTINCT path FROM head_lines WHERE repo_id = ?').all(repo.id).map((r) => r.path);
  const binary = binaryPaths(repo.path, repo.head, pathspecs);
  const todo = all.filter((p) => !done.has(p));
  if (todo.length === 0) {
    report('already blamed');
    return;
  }

  const update = db.prepare('UPDATE head_lines SET blame_identity_id = ? WHERE repo_id = ? AND path = ? AND line = ?');
  const markDone = db.prepare('INSERT OR IGNORE INTO blame_files (repo_id, path) VALUES (?, ?)');
  let finished = 0;
  let failed = 0;
  let inBatch = 0;
  let last = Date.now();
  const started = Date.now();

  db.exec('BEGIN');
  const record = (path, authors) => {
    for (const [line, author] of authors) update.run(identityId(author.name, author.email), repo.id, path, line);
    markDone.run(repo.id, path);
    finished++;
    if (++inBatch >= BATCH_FILES) {
      db.exec('COMMIT; BEGIN');
      inBatch = 0;
    }
    if (Date.now() - last >= PROGRESS_INTERVAL_MS) {
      last = Date.now();
      report(`${done.size + finished}/${all.length} files, ${((Date.now() - started) / 1000).toFixed(0)}s`);
    }
  };

  try {
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const path = todo[next++];
        if (binary.has(path)) {
          record(path, []);
          continue;
        }
        try {
          record(path, await gitBlame(repo.path, repo.head, path));
        } catch (err) {
          // Left out of blame_files, so a later run retries it.
          failed++;
          report(`failed on ${path}: ${err.message.split('\n')[0]}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, jobs) }, worker));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  report(`done, ${done.size + finished}/${all.length} files${failed ? `, ${failed} failed (rerun to retry)` : ''}`);
}

// Same identity rules as indexing: one identity per lowercased email. Blame can
// name authors the history walk never saw (for example, merge commits); they get
// an identity with the name blame reports.
function identityResolver(db) {
  const insert = db.prepare('INSERT OR IGNORE INTO identities (email, name) VALUES (?, ?)');
  const select = db.prepare('SELECT id FROM identities WHERE email = ?');
  const ids = new Map();
  return (name, email) => {
    const key = email.toLowerCase();
    let id = ids.get(key);
    if (id === undefined) {
      insert.run(key, name);
      id = select.get(key).id;
      ids.set(key, id);
    }
    return id;
  };
}
