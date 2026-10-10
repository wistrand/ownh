import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { createDb, openDbForWrite } from './db.js';
import { toPathspecs } from './exclude.js';
import { BYTES, COMMIT_MARK, WALK_OPTIONS, attrBinary, binaryPaths, catBlobs, git, headFiles, isShallow, log, looksBinary, utf8 } from './git.js';
import { hashFile, hashLine } from './hash.js';
import { quarterOf } from './timeline.js';

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
  binary      = excluded.binary,
  text        = excluded.text,
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

// Lines added and removed per (hash, repo, quarter, author), summed across
// commits. Owners are resolved at report time through line_hashes.
const UPSERT_CHURN = `
INSERT INTO churn (hash, repo_id, q, identity_id, added, removed) VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT (hash, repo_id, q, identity_id) DO UPDATE SET
  added = added + excluded.added,
  removed = removed + excluded.removed
`;

// Submodule entries show up in diffs as "+Subproject commit <sha>" and
// "-Subproject commit <sha>" lines.
const SUBMODULE_HEADER = /^(?:new file mode|deleted file mode|index [0-9a-f]+\.\.[0-9a-f]+) 160000$/;
// With --full-index, the pre- and post-image blob ids of a file diff.
const INDEX_HEADER = /^index ([0-9a-f]+)\.\.([0-9a-f]+)/;
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
// With --force the new .db is built in a temporary file next to it and renamed
// over the old one only on success, so a failed rebuild keeps the old .db.
export async function index({ dbPath, repoPaths, excludes = [], force = false, log: report = () => {} }) {
  const repos = describeRepos(repoPaths);
  if (existsSync(dbPath) && !force) throw new Error(`${dbPath} exists; pass --force to rebuild it, or use add`);
  const tmpPath = `${dbPath}.building-${process.pid}`;
  rmSync(tmpPath, { force: true });
  const db = createDb(tmpPath);
  try {
    await indexInto(db, repos, excludes, report);
  } catch (err) {
    db.close();
    rmSync(tmpPath, { force: true });
    rmSync(`${tmpPath}-journal`, { force: true });
    throw err;
  }
  db.close();
  renameSync(tmpPath, dbPath);
}

// Adds repos to an existing .db. The result is the same as indexing all repos
// from scratch, provided the exclude list is the same; anything else is refused.
export async function add({ dbPath, repoPaths, excludes = [], log: report = () => {} }) {
  const repos = describeRepos(repoPaths);
  if (!existsSync(dbPath)) throw new Error(`${dbPath} does not exist; use index to create it`);
  const db = openDbForWrite(dbPath);
  try {
    const columns = new Set(db.prepare("SELECT name FROM pragma_table_info('commits')").all().map((c) => c.name));
    const hasChurn = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'churn'").get();
    if (!columns.has('author_name') || !columns.has('added_blank') || !columns.has('is_merge') || !hasChurn) {
      throw new Error(`${dbPath} was built by an older ownh version; rebuild it with index`);
    }
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
    let head;
    try {
      head = git(resolve(p), ['rev-parse', '--verify', 'HEAD^{commit}']).trim();
    } catch {
      throw new Error(`${p} is not a git repository with at least one commit`);
    }
    // The repo's own root, whatever path inside it was given (a subdirectory,
    // its .git directory), so the name and the exclude pathspecs do not depend
    // on how the path was typed.
    const path = repoRoot(resolve(p));
    if (isShallow(path)) throw new Error(`${p} is a shallow clone; fetch its full history first (git fetch --unshallow)`);
    const name = basename(path).replace(/\.git$/, '');
    if (!name) throw new Error(`${p}: cannot derive a repository name from ${path}`);
    return { name, path, head };
  });
  repos.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (let i = 1; i < repos.length; i++) {
    if (repos[i].name === repos[i - 1].name) {
      throw new Error(`two repos are named "${repos[i].name}" (${repos[i - 1].path}, ${repos[i].path}); repo names must be unique`);
    }
  }
  return repos;
}

// Work-tree root for a normal repo, the git directory for a bare one, and the
// work tree for a path inside a .git directory.
function repoRoot(path) {
  const ask = (arg) => git(path, ['rev-parse', arg]).trim();
  if (ask('--is-bare-repository') === 'true') return ask('--absolute-git-dir');
  if (ask('--is-inside-git-dir') === 'true') return dirname(ask('--absolute-git-dir'));
  return ask('--show-toplevel');
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
  const insertCommit = db.prepare('INSERT INTO commits (repo_id, sha, topo, author_time, identity_id, author_name, is_merge) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const upsertHash = db.prepare(UPSERT_HASH);
  const setAdded = db.prepare('UPDATE commits SET added_lines = ?, added_blank = ? WHERE id = ?');
  const upsertChurn = db.prepare(UPSERT_CHURN);
  let commit = null;
  let topo = 0;
  let added = 0;
  let seen = new Set();
  // Per-commit churn: hash -> [added, removed]. Flushed when the next commit starts.
  let churn = new Map();
  let path = null;
  let oldPath = null;
  let headerPath = null;
  let oldOid = null;
  let newOid = null;
  let inHunk = false;
  let skipFile = false;
  // "Binary files differ" diffs carry no content, only blob ids. git prints one
  // when either side is binary, so each side is read and classified on its own
  // after the walk, the way HEAD scoring classifies a file: a binary side is one
  // line (ownership and churn), a text side is its lines.
  const binaryDiffs = [];
  const total = Number(git(repo.path, ['rev-list', '--count', ...WALK_OPTIONS, repo.head, '--', ...pathspecs]).trim());
  const progress = throttled(() => report(`${repo.name}: history ${topo}/${total} commits, ${added} lines hashed`));

  const count = (hash, column) => {
    let entry = churn.get(hash);
    if (!entry) churn.set(hash, (entry = [0, 0]));
    entry[column]++;
  };
  const flushCommit = () => {
    if (!commit) return;
    if (commit.addedLines) setAdded.run(commit.addedLines, commit.addedBlank, commit.id);
    for (const [hash, [a, r]] of churn) upsertChurn.run(hash, repo.id, commit.q, commit.identity, a, r);
    churn = new Map();
  };

  for await (const line of log(repo.path, repo.head, pathspecs)) {
    if (line.startsWith(COMMIT_MARK)) {
      flushCommit();
      const [sha, time, name, email, parents] = utf8(line.slice(COMMIT_MARK.length)).split('\0');
      const authorTime = Number(time);
      const isMerge = parents.trim().split(/\s+/).length > 1;
      const identity = identityId(name, email);
      const id = Number(insertCommit.run(repo.id, sha, topo, authorTime, identity, name, isMerge ? 1 : 0).lastInsertRowid);
      commit = { id, topo, authorTime, identity, isMerge, q: quarterOf(authorTime), addedLines: 0, addedBlank: 0 };
      topo++;
      progress();
      seen = new Set();
      inHunk = false;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      headerPath = diffHeaderPath(utf8(line));
      path = headerPath;
      oldPath = headerPath;
      oldOid = null;
      newOid = null;
      inHunk = false;
      skipFile = false;
      continue;
    }
    if (!inHunk) {
      if (line.startsWith('+++ ')) path = parsePath(utf8(line.slice(4)), 'b/');
      else if (line.startsWith('--- ')) oldPath = parsePath(utf8(line.slice(4)), 'a/');
      else if (line.startsWith('rename from ')) oldPath = unquote(utf8(line.slice(12)));
      else if (line.startsWith('rename to ')) path = unquote(utf8(line.slice(10)));
      else if (SUBMODULE_HEADER.test(line)) skipFile = true;
      else if (line.startsWith('@@')) inHunk = true;
      else if (line.startsWith('Binary files ')) {
        if (!skipFile) {
          binaryDiffs.push({
            commit,
            newOid: newOid && !NULL_OID.test(newOid) ? newOid : null,
            // Removals inside a merge are not real removals (see below).
            oldOid: !commit.isMerge && oldOid && !NULL_OID.test(oldOid) ? oldOid : null,
            path: path ?? binaryPath(utf8(line)),
            oldPath,
          });
        }
      } else {
        const m = INDEX_HEADER.exec(line);
        if (m) {
          oldOid = m[1];
          newOid = m[2];
        }
      }
      continue;
    }
    // With --unified=0 a hunk holds only "+", "-", "@@" and "\ No newline" lines.
    if (skipFile) continue;
    const c0 = line.charCodeAt(0);
    if (c0 === 45) {
      // Removals inside a merge are relative to git's re-run merge, not to a
      // parent, so they are not real removals.
      if (!commit.isMerge) count(hashLine(line.slice(1)), 1);
      continue;
    }
    if (c0 !== 43) continue;
    const text = line.slice(1);
    commit.addedLines++;
    if (text === '') commit.addedBlank++;
    const hash = hashLine(text);
    count(hash, 0);
    if (seen.has(hash)) continue;
    seen.add(hash);
    upsertHash.run(hash, 0, utf8(text), commit.authorTime, repo.id, commit.topo, commit.id, path, repo.name);
    added++;
  }
  flushCommit();

  // Classify each side of the binary diffs: gitattributes for its path, then
  // git's content check for the blob. Text sides need their lines; only those
  // blobs are kept in memory.
  const attr = attrBinary(repo.path, [...new Set(binaryDiffs.flatMap((d) => [d.path, d.oldPath]).filter(Boolean))]);
  const sideBinaryByAttr = (p) => p !== null && attr.has(p);
  const needLines = new Set();
  for (const d of binaryDiffs) {
    if (d.newOid && !sideBinaryByAttr(d.path)) needLines.add(d.newOid);
    if (d.oldOid && !sideBinaryByAttr(d.oldPath)) needLines.add(d.oldOid);
  }
  const blobs = new Map(); // oid -> { hash, binary, lines }
  const oids = [...new Set(binaryDiffs.flatMap((d) => [d.newOid, d.oldOid]).filter(Boolean))];
  let k = 0;
  for await (const content of catBlobs(repo.path, oids)) {
    const oid = oids[k++];
    const binary = looksBinary(content);
    blobs.set(oid, { hash: hashFile(content), binary, lines: !binary && needLines.has(oid) ? splitLines(content) : null });
  }
  const addText = db.prepare('UPDATE commits SET added_lines = COALESCE(added_lines, 0) + ?, added_blank = COALESCE(added_blank, 0) + ? WHERE id = ?');
  let binaryFiles = 0;
  for (const { commit: c, newOid, oldOid, path: p, oldPath: op } of binaryDiffs) {
    if (newOid) {
      const blob = blobs.get(newOid);
      if (blob.binary || sideBinaryByAttr(p)) {
        upsertHash.run(blob.hash, 1, null, c.authorTime, repo.id, c.topo, c.id, p, repo.name);
        upsertChurn.run(blob.hash, repo.id, c.q, c.identity, 1, 0);
        binaryFiles++;
      } else {
        let blank = 0;
        for (const text of blob.lines) {
          const hash = hashLine(text);
          if (text === '') blank++;
          upsertHash.run(hash, 0, utf8(text), c.authorTime, repo.id, c.topo, c.id, p, repo.name);
          upsertChurn.run(hash, repo.id, c.q, c.identity, 1, 0);
          added++;
        }
        addText.run(blob.lines.length, blank, c.id);
      }
    }
    if (oldOid) {
      const blob = blobs.get(oldOid);
      if (blob.binary || sideBinaryByAttr(op)) upsertChurn.run(blob.hash, repo.id, c.q, c.identity, 0, 1);
      else for (const text of blob.lines) upsertChurn.run(hashLine(text), repo.id, c.q, c.identity, 0, 1);
    }
  }
  report(`${repo.name}: ${topo} commits, ${added} added lines and ${binaryFiles} binary files hashed`);
}

// A blob's lines as byte strings, split exactly as HEAD scoring splits them.
function splitLines(content) {
  const lines = content.toString(BYTES).split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

// "Binary files a/x and b/x differ"; the post-image is /dev/null for deletions.
// A fallback only: the path normally comes from the diff header.
function binaryPath(line) {
  const m = / and (b\/.*|"b\/.*") differ$/.exec(line);
  return m ? parsePath(m[1], 'b/') : null;
}

// The path from "diff --git a/<p> b/<p>" when both sides are the same path (no
// rename), which is the only case where it can be read unambiguously.
function diffHeaderPath(line) {
  const rest = line.slice('diff --git '.length);
  if (rest.startsWith('"')) {
    const m = /^("(?:[^"\\]|\\.)*") /.exec(rest);
    return m ? parsePath(m[1], 'a/') : null;
  }
  const half = (rest.length - 1) / 2;
  if (!Number.isInteger(half) || rest[half] !== ' ') return null;
  const a = rest.slice(0, half);
  const b = rest.slice(half + 1);
  return a.startsWith('a/') && b.startsWith('b/') && a.slice(2) === b.slice(2) ? a.slice(2) : null;
}

// Paths in "--- a/<p>" and "+++ b/<p>" lines. git appends a tab to an unquoted
// name that contains a space; it is not part of the name.
function parsePath(raw, prefix) {
  if (raw === '/dev/null') return null;
  let path = raw.startsWith('"') ? unquote(raw) : raw.replace(/\t$/, '');
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

// git quotes names with special characters C-style, which JSON can read.
function unquote(raw) {
  if (!raw.startsWith('"')) return raw;
  try { return JSON.parse(raw); } catch { return raw; }
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
    const lines = splitLines(content);
    for (let n = 0; n < lines.length; n++) insert.run(repo.id, path, n + 1, hashLine(lines[n]));
    scored += lines.length;
    progress();
  }
  report(`${repo.name}: ${scored} lines at HEAD`);
}
