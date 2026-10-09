import { DatabaseSync } from 'node:sqlite';

// The first-introducer tiebreak compares repos.name, never repos.id: ids follow
// insertion order, and `ownh add` appends. See UPSERT_HASH in indexer.js.
//
// line_hashes.text is NULL for binary files, which count as one line whose hash
// covers the whole file.
//
// line_hashes keeps (author_time, repo_id, topo) next to commit_id so the
// first-introducer upsert can compare keys without a join.
const SCHEMA = `
CREATE TABLE runs (
  id            INTEGER PRIMARY KEY,
  tool_version  TEXT NOT NULL,
  excludes      TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  finished_at   TEXT
);

CREATE TABLE repos (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL,
  head TEXT NOT NULL
);

CREATE TABLE identities (
  id    INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name  TEXT NOT NULL
);

CREATE TABLE commits (
  id          INTEGER PRIMARY KEY,
  repo_id     INTEGER NOT NULL REFERENCES repos (id),
  sha         TEXT NOT NULL,
  topo        INTEGER NOT NULL,
  author_time INTEGER NOT NULL,
  identity_id INTEGER NOT NULL REFERENCES identities (id),
  author_name TEXT NOT NULL,
  UNIQUE (repo_id, sha)
);

CREATE INDEX commits_identity ON commits (identity_id);

CREATE TABLE line_hashes (
  hash        TEXT PRIMARY KEY,
  binary      INTEGER NOT NULL,
  text        TEXT,
  author_time INTEGER NOT NULL,
  repo_id     INTEGER NOT NULL REFERENCES repos (id),
  topo        INTEGER NOT NULL,
  commit_id   INTEGER NOT NULL REFERENCES commits (id),
  path        TEXT
) WITHOUT ROWID;

CREATE TABLE head_lines (
  repo_id           INTEGER NOT NULL REFERENCES repos (id),
  path              TEXT NOT NULL,
  line              INTEGER NOT NULL,
  hash              TEXT NOT NULL,
  blame_identity_id INTEGER REFERENCES identities (id),
  PRIMARY KEY (repo_id, path, line)
) WITHOUT ROWID;

CREATE INDEX head_lines_hash ON head_lines (hash);
`;

// Wait for another ownh process's lock (a report reading while blame commits,
// or the reverse) instead of failing with "database is locked".
const BUSY_TIMEOUT_MS = 10 * 60 * 1000;

export function createDb(path) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  // The .db is always rebuilt from scratch, so durability during the run buys nothing.
  db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = OFF;');
  db.exec(SCHEMA);
  return db;
}

// An existing .db holds hours of work (add, blame), so writes to it keep the
// default durability; only a fresh index skips it.
export function openDbForWrite(path) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  return db;
}

export function openDb(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  return db;
}
