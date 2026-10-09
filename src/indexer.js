import { existsSync, readFileSync, rmSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { createDb, openDbForWrite } from './db.js';
import { toPathspecs } from './exclude.js';
import { COMMIT_MARK, binaryPaths, catBlobs, git, headFiles, log } from './git.js';
import { hashFile, hashLine } from './hash.js';

const TOOL_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

// A hash's owner is the commit with the smallest (author_time, repo name, topo)
// key that adds the line. Taking the minimum, rather than walking one merged
// timeline, gives the same answer whatever order repos and commits are processed
// in, including repos added later with `ownh add`. The repo comparison uses names,
// not ids: ids follow insertion order, which `add` does not keep sorted.
//
// Parameters: the eight column values, then the new row's repo name.
const UPSERT_HASH = `
INSERT INTO line_hashes (hash, binary, text, author_time, repo_id, topo, commit_id, path)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (hash) DO UPDATE SET
  author_time = excluded.author_time,
  repo_id     = excluded.repo_id,
  topo        = excluded.topo,
  commit_id   = excluded.commit_id,
  path        = excluded.path
WHERE excluded.author_time < line_hashes.author_time
   OR (excluded.author_time = line_hashes.author_time AND (
        (excluded.repo_id = line_hashes.repo_id AND excluded.topo < line_hashes.topo)
     OR (excluded.repo_id <> line_hashes.repo_id
         AND ? < (SELECT name FROM repos WHERE id = line_hashes.repo_id))))
`;

// Submodule entries show up in diffs as "+Subproject commit <sha>" lines.
const SUBMODULE_HEADER = /^(?:new file mode|index [0-9a-f]+\.\.[0-9a-f]+) 160000$/;
// With --full-index, the post-image blob id of a file diff.
const INDEX_HEADER = /^index [0-9a-f]+\.\.([0-9a-f]+)/;
const NULL_OID = /^0+$/;
const PROGRESS_INTERVAL_MS = 5000;

// Calls `fn` at most once per PROGRESS_INTERVAL_MS.
function throttled(fn) {
  let last = Date.now();
  return (...args) => {
    const now = Date.now();
    if (now - last < PROGRESS_INTERVAL_MS) return;
    last = now;
    fn(...args);
  };
}

// `excludes` are patterns in the ownh.exclude syntax (see src/exclude.js). They
// apply to every repo, to history and HEAD alike.
export async function index({ dbPath, repoPaths, excludes = [], force = false, log: report = () => {} }) {
  const repos = describeRepos(repoPaths);
  if (existsSync(dbPath)) {
    if (!force) throw new Error(`${dbPath} exists; pass --force to rebuild it, or use add`);
    rmSync(dbPath);
  }
  const db = createDb(dbPath);
  try {
    await indexInto(db, repos, excludes, report);
  } finally {
    db.close();
  }
}

// Adds repos to an existing .db. The result is the same as indexing all repos
// from scratch, provided the exclude list is the same; anything else is refused.
export async function add({ dbPath, repoPaths, excludes = [], log: report = () => {} }) {
  const repos = describeRepos(repoPaths);
  if (!existsSync(dbPath)) throw new Error(`${dbPath} does not exist; use index to create it`);
  const db = openDbForWrite(dbPath);
  try {
    const hasNames = db.prepare("SELECT 1 FROM pragma_table_info('commits') WHERE name = 'author_name'").get();
    if (!hasNames) throw new Error(`${dbPath} was built by an older ownh version; rebuild it with index`);
    const stored = db.prepare('SELECT excludes FROM runs ORDER BY id LIMIT 1').get();
    if (!stored) throw new Error(`${dbPath} has no completed index run`);
    const storedExcludes = JSON.parse(stored.excludes);
    if (!sameExcludes(storedExcludes, excludes)) {
      throw new Error(`exclude list differs from the one ${dbPath} was built with: [${storedExcludes.join(', ')}]`);
    }
    const existing = db.prepare('SELECT name FROM repos WHERE name = ?');
    for (const repo of repos) {
      if (existing.get(repo.name)) throw new Error(`${dbPath} already has a repo named "${repo.name}"`);
    }
    await indexInto(db, repos, excludes, report);
  } finally {
    db.close();
  }
}

function sameExcludes(a, b) {
  const norm = (list) => JSON.stringify([...new Set(list)].sort());
  return norm(a) === norm(b);
}

// One transaction per run, so a failed add leaves the .db as it was.
async function indexInto(db, repos, excludes, report) {
  const pathspecs = toPathspecs(excludes);
  db.exec('BEGIN');
  try {
    const runId = Number(db.prepare('INSERT INTO runs (tool_version, excludes, started_at) VALUES (?, ?, ?)')
      .run(TOOL_VERSION, JSON.stringify(excludes), new Date().toISOString()).lastInsertRowid);
    insertRepos(db, repos);
    const identityId = identityResolver(db);
    for (const repo of repos) await indexHistory(db, repo, pathspecs, identityId, report);
    for (const repo of repos) await indexHead(db, repo, pathspecs, report);
    refreshDisplayNames(db);
    db.prepare('UPDATE runs SET finished_at = ? WHERE id = ?').run(new Date().toISOString(), runId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function describeRepos(repoPaths) {
  const repos = repoPaths.map((p) => {
    const path = resolve(p);
    let head;
    try {
      head = git(path, ['rev-parse', '--verify', 'HEAD^{commit}']).trim();
    } catch {
      throw new Error(`${p} is not a git repository with at least one commit`);
    }
    return { name: basename(path).replace(/\.git$/, ''), path, head };
  });
  repos.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (let i = 1; i < repos.length; i++) {
    if (repos[i].name === repos[i - 1].name) {
      throw new Error(`two repos are named "${repos[i].name}" (${repos[i - 1].path}, ${repos[i].path}); repo names must be unique`);
    }
  }
  return repos;
}

function insertRepos(db, repos) {
  const insert = db.prepare('INSERT INTO repos (name, path, head) VALUES (?, ?, ?)');
  for (const repo of repos) repo.id = Number(insert.run(repo.name, repo.path, repo.head).lastInsertRowid);
}

// One identity per lowercased email across all repos. The display name is set
// afterwards by refreshDisplayNames from the names stored on each commit.
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

// Display name = the name on the most commits for that email, across every repo
// in the .db; ties go to the smallest name. Recomputed after every run, so it
// doesn't depend on which repo was indexed or added first.
function refreshDisplayNames(db) {
  db.exec(`
    UPDATE identities SET name = (
      SELECT c.author_name FROM commits c
      WHERE c.identity_id = identities.id
      GROUP BY c.author_name
      ORDER BY COUNT(*) DESC, c.author_name
      LIMIT 1
    )
    WHERE EXISTS (SELECT 1 FROM commits c WHERE c.identity_id = identities.id)
  `);
}

async function indexHistory(db, repo, pathspecs, identityId, report) {
  const insertCommit = db.prepare('INSERT INTO commits (repo_id, sha, topo, author_time, identity_id, author_name) VALUES (?, ?, ?, ?, ?, ?)');
  const upsertHash = db.prepare(UPSERT_HASH);
  let commit = null;
  let topo = 0;
  let added = 0;
  let seen = new Set();
  let path = null;
  let newOid = null;
  let inHunk = false;
  let skipFile = false;
  // Binary diffs carry no content, only blob ids; their files are read and
  // hashed after the walk.
  const binaries = [];
  const total = Number(git(repo.path, ['rev-list', '--count', '--no-merges', repo.head, '--', ...pathspecs]).trim());
  const progress = throttled(() => report(`${repo.name}: history ${topo}/${total} commits, ${added} lines hashed`));

  for await (const line of log(repo.path, repo.head, pathspecs)) {
    if (line.startsWith(COMMIT_MARK)) {
      const [sha, time, name, email] = line.slice(COMMIT_MARK.length).split('\0');
      const authorTime = Number(time);
      const id = Number(insertCommit.run(repo.id, sha, topo, authorTime, identityId(name, email), name).lastInsertRowid);
      commit = { id, topo, authorTime };
      topo++;
      progress();
      seen = new Set();
      inHunk = false;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      path = null;
      newOid = null;
      inHunk = false;
      skipFile = false;
      continue;
    }
    if (!inHunk) {
      if (line.startsWith('+++ ')) path = parsePath(line.slice(4));
      else if (SUBMODULE_HEADER.test(line)) skipFile = true;
      else if (line.startsWith('@@')) inHunk = true;
      else if (line.startsWith('Binary files ')) {
        if (!skipFile && newOid && !NULL_OID.test(newOid)) binaries.push({ oid: newOid, commit, path: binaryPath(line) });
      } else {
        const m = INDEX_HEADER.exec(line);
        if (m) newOid = m[1];
      }
      continue;
    }
    // With --unified=0 a hunk holds only "+", "-", "@@" and "\ No newline" lines.
    if (skipFile || line.charCodeAt(0) !== 43) continue;
    const text = line.slice(1);
    const hash = hashLine(text);
    if (seen.has(hash)) continue;
    seen.add(hash);
    upsertHash.run(hash, 0, text, commit.authorTime, repo.id, commit.topo, commit.id, path, repo.name);
    added++;
  }

  const fileHashes = new Map();
  const oids = [...new Set(binaries.map((b) => b.oid))];
  let k = 0;
  for await (const content of catBlobs(repo.path, oids)) fileHashes.set(oids[k++], hashFile(content));
  for (const { oid, commit: c, path: p } of binaries) {
    upsertHash.run(fileHashes.get(oid), 1, null, c.authorTime, repo.id, c.topo, c.id, p, repo.name);
  }
  report(`${repo.name}: ${topo} commits, ${added} added lines and ${binaries.length} binary files hashed`);
}

// "Binary files a/x and b/x differ"; the post-image is /dev/null for deletions,
// which never reach here.
function binaryPath(line) {
  const m = / and (b\/.*|"b\/.*") differ$/.exec(line);
  return m ? parsePath(m[1]) : null;
}

function parsePath(raw) {
  if (raw === '/dev/null') return null;
  let path = raw;
  if (path.startsWith('"')) {
    try { path = JSON.parse(path); } catch { /* keep git's quoted form */ }
  }
  return path.startsWith('b/') ? path.slice(2) : path;
}

async function indexHead(db, repo, pathspecs, report) {
  const entries = headFiles(repo.path, repo.head, pathspecs);
  const binary = binaryPaths(repo.path, repo.head, pathspecs);
  const insert = db.prepare('INSERT INTO head_lines (repo_id, path, line, hash) VALUES (?, ?, ?, ?)');
  let i = 0;
  let scored = 0;
  const progress = throttled(() => report(`${repo.name}: HEAD ${i}/${entries.length} files, ${scored} lines`));

  for await (const content of catBlobs(repo.path, entries.map((e) => e.oid))) {
    const { path } = entries[i++];
    if (binary.has(path)) {
      insert.run(repo.id, path, 1, hashFile(content));
      scored++;
      continue;
    }
    const lines = content.toString('utf8').split('\n');
    if (lines.at(-1) === '') lines.pop();
    for (let n = 0; n < lines.length; n++) insert.run(repo.id, path, n + 1, hashLine(lines[n]));
    scored += lines.length;
    progress();
  }
  report(`${repo.name}: ${scored} lines at HEAD`);
}
