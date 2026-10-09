import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { openDb } from '../src/db.js';
import { toPathspecs } from '../src/exclude.js';
import { blame } from '../src/blame.js';
import { add, index } from '../src/indexer.js';
import { report } from '../src/report.js';
import { collectStats } from '../src/stats.js';
import { summary } from '../src/summary.js';
import { buildFixtures, commit, init } from './fixtures.js';

const ALICE = 'alice@example.com';

// Owner email for every line at HEAD, keyed "repo/path:line".
function owners(dbPath) {
  const db = openDb(dbPath);
  try {
    const rows = db.prepare(`
      SELECT r.name AS repo, h.path, h.line, i.email
      FROM head_lines h
      JOIN repos r ON r.id = h.repo_id
      LEFT JOIN line_hashes l ON l.hash = h.hash
      LEFT JOIN commits c ON c.id = l.commit_id
      LEFT JOIN identities i ON i.id = c.identity_id
    `).all();
    return Object.fromEntries(rows.map((r) => [`${r.repo}/${r.path}:${r.line}`, r.email]));
  } finally {
    db.close();
  }
}

let dir;
let repos;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'ownh-test-'));
  repos = buildFixtures(dir);
});

after(() => rmSync(dir, { recursive: true, force: true }));

test('first introducer owns each exact line, across repos', async () => {
  const db = join(dir, 'owners.db');
  await index({ dbPath: db, repoPaths: [repos.alpha, repos.beta] });
  assert.deepEqual(owners(db), {
    'alpha/.gitattributes:1': 'leo@example.com',
    'alpha/.mailmap:1': ALICE,
    'alpha/a.js:1': ALICE,
    'alpha/a.js:2': ALICE, // erin's revert re-adds alice's line; dave's change is gone
    'alpha/a.js:3': ALICE,
    'alpha/a.js:4': 'grace@example.com', // first written in beta, earlier
    'alpha/a.js:5': 'heidi@example.com', // timestamp tie with ivan; alpha sorts before beta
    'alpha/b.js:1': 'bob@example.com',
    'alpha/b.js:2': 'frank@example.com', // blank line: frank's (beta, t=1500) predates bob's
    'alpha/b.js:3': 'carol@example.com', // the reindent is a new line, owned by the formatter
    'alpha/b.js:4': ALICE, // the brace baron
    'alpha/data.txt:1': 'leo@example.com', // binary by attribute: the whole file is one line
    'alpha/logo.png:1': 'kate@example.com', // same bytes, first committed in beta
    'beta/copy.js:1': ALICE,
    'beta/copy.js:2': ALICE,
    'beta/copy.js:3': ALICE,
    'beta/copy.js:4': 'frank@example.com',
    'beta/copy.js:5': 'frank@example.com',
    'beta/logo.png:1': 'kate@example.com',
    'beta/shared.js:1': 'grace@example.com',
    'beta/shared.js:2': 'heidi@example.com',
    'beta/win.js:1': 'judy@example.com', // "function a() {\r" is not alice's line
    'beta/win.js:2': 'judy@example.com', // "\r" is not the blank line
    'beta/win.js:3': 'judy@example.com',
  });
});

test('mailmap merges identities', async () => {
  const db = join(dir, 'mailmap.db');
  await index({ dbPath: db, repoPaths: [repos.alpha] });
  const conn = openDb(db);
  try {
    const emails = conn.prepare('SELECT email FROM identities ORDER BY email').all().map((r) => r.email);
    assert.ok(emails.includes(ALICE));
    assert.ok(!emails.includes('alice@old.example.com'));
  } finally {
    conn.close();
  }
});

test('repo argument order does not change the result', async () => {
  const ab = join(dir, 'ab.db');
  const ba = join(dir, 'ba.db');
  await index({ dbPath: ab, repoPaths: [repos.alpha, repos.beta] });
  await index({ dbPath: ba, repoPaths: [repos.beta, repos.alpha] });
  assert.deepEqual(owners(ab), owners(ba));
  assert.equal(summary({ dbPath: ab }), summary({ dbPath: ba }));
});

test('refuses to overwrite an existing db without force', async () => {
  const db = join(dir, 'exists.db');
  await index({ dbPath: db, repoPaths: [repos.alpha] });
  await assert.rejects(index({ dbPath: db, repoPaths: [repos.alpha] }), /exists/);
  await index({ dbPath: db, repoPaths: [repos.alpha], force: true });
});

test('excluded files vanish from history and HEAD', async () => {
  const db = join(dir, 'exclude.db');
  await index({ dbPath: db, repoPaths: [repos.alpha, repos.beta], excludes: ['copy.js', '*.png'] });
  const o = owners(db);
  assert.ok(!Object.keys(o).some((k) => k.startsWith('beta/copy.js') || k.endsWith('logo.png:1')));
  // frank's blank line lived only in copy.js, so the first blank line is now bob's
  assert.equal(o['alpha/b.js:2'], 'bob@example.com');
  assert.ok(summary({ dbPath: db }).includes('excluded patterns: copy.js, *.png'));
});

test('exclude patterns become git exclude pathspecs', () => {
  assert.deepEqual(toPathspecs(['dist/']), [':(exclude,glob)**/dist/**']);
  assert.deepEqual(toPathspecs(['*.png']), [':(exclude,glob)**/*.png', ':(exclude,glob)**/*.png/**']);
  assert.deepEqual(toPathspecs(['/build', 'conf/a.json']), [
    ':(exclude,glob)build', ':(exclude,glob)build/**',
    ':(exclude,glob)conf/a.json', ':(exclude,glob)conf/a.json/**',
  ]);
});

test('add gives the same result as indexing everything at once', async () => {
  const full = join(dir, 'full.db');
  const added = join(dir, 'added.db');
  await index({ dbPath: full, repoPaths: [repos.alpha, repos.beta] });
  // beta first, so alpha gets the higher repo id; the heidi/ivan tie must still go to alpha
  await index({ dbPath: added, repoPaths: [repos.beta] });
  await add({ dbPath: added, repoPaths: [repos.alpha] });
  assert.deepEqual(owners(added), owners(full));
  assert.equal(owners(added)['beta/shared.js:2'], 'heidi@example.com');
  assert.equal(summary({ dbPath: added }), summary({ dbPath: full }));
});

test('add refuses a different exclude list or a repo already present', async () => {
  const db = join(dir, 'add-guards.db');
  await index({ dbPath: db, repoPaths: [repos.beta], excludes: ['*.png'] });
  await assert.rejects(add({ dbPath: db, repoPaths: [repos.alpha] }), /exclude list differs/);
  await assert.rejects(add({ dbPath: db, repoPaths: [repos.beta], excludes: ['*.png'] }), /already has a repo named "beta"/);
  await assert.rejects(add({ dbPath: join(dir, 'missing.db'), repoPaths: [repos.alpha] }), /does not exist/);
});

test('display name is the most-used name for an email', async () => {
  const gamma = init(dir, 'gamma');
  const db = join(dir, 'names.db');
  commit(gamma, ['zed', 'zed@example.com'], 100, { 'z.txt': '1\n' });
  commit(gamma, ['zed', 'zed@example.com'], 200, { 'z.txt': '2\n' });
  commit(gamma, ['Zed Real', 'zed@example.com'], 300, { 'z.txt': '3\n' }); // sorts first, used less
  await index({ dbPath: db, repoPaths: [gamma] });
  const conn = openDb(db);
  try {
    assert.equal(conn.prepare("SELECT name FROM identities WHERE email = 'zed@example.com'").get().name, 'zed');
  } finally {
    conn.close();
  }
});

test('report files agree with the summary', async () => {
  const db = join(dir, 'report.db');
  const out = join(dir, 'report');
  await index({ dbPath: db, repoPaths: [repos.alpha, repos.beta] });
  report({ dbPath: db, outDir: out, top: 5 });
  assert.deepEqual(readdirSync(out).sort(), [
    'cross-ownership.csv', 'cross-ownership.svg', 'leaderboard.md', 'lines.csv', 'methods.csv',
    'owners.csv', 'ownership-by-line-hash.svg', 'report.html', 'report.json',
  ]);
  const json = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
  assert.equal(json.total, 24);
  assert.equal(json.owners[0].owner.email, ALICE);
  assert.equal(json.owners[0].lines, 8);
  assert.ok(summary({ dbPath: db }).includes('lines scored: 24'));
  // beta: 4 of 11 lines first written in alpha (alice's copy.js lines and heidi's tie)
  const cross = readFileSync(join(out, 'cross-ownership.csv'), 'utf8');
  assert.ok(cross.includes('beta,alpha,4,0.36363636363636365'));
  const leaderboard = readFileSync(join(out, 'leaderboard.md'), 'utf8');
  assert.ok(leaderboard.includes('| beta       |    11 |                  36.4% |'));
  // Renderers like rsvg ignore CSS variables; charts must use plain colors.
  for (const svg of ['cross-ownership.svg', 'ownership-by-line-hash.svg']) {
    assert.ok(!readFileSync(join(out, svg), 'utf8').includes('var('));
  }
});

test('three methods: commits, blame, line hash', async () => {
  const db = join(dir, 'methods.db');
  await index({ dbPath: db, repoPaths: [repos.alpha, repos.beta] });

  const before = withDb(db, (conn) => collectStats(conn));
  assert.equal(before.methods.blame, null); // not blamed yet
  assert.equal(before.repos[0].methods.commits.owner.email, ALICE); // 2 of 8 alpha commits

  await blame({ dbPath: db, jobs: 2 });
  const blamed = withDb(db, (conn) => ({
    // erin's revert re-added alice's line: blame names erin, line hash names alice
    a2: conn.prepare(`SELECT i.email FROM head_lines h JOIN identities i ON i.id = h.blame_identity_id
                      WHERE h.path = 'a.js' AND h.line = 2`).get().email,
    // blame honors .mailmap: alice's old email never appears
    old: conn.prepare("SELECT COUNT(*) AS n FROM identities WHERE email = 'alice@old.example.com'").get().n,
    // binary files are skipped by blame
    png: conn.prepare("SELECT COUNT(*) AS n FROM head_lines WHERE path = 'logo.png' AND blame_identity_id IS NOT NULL").get().n,
    stats: collectStats(conn),
  }));
  assert.equal(blamed.a2, 'erin@example.com');
  assert.equal(blamed.old, 0);
  assert.equal(blamed.png, 0);

  const [alpha, beta] = blamed.stats.repos;
  assert.equal(alpha.methods.blame.owner.email, ALICE);
  assert.ok(alpha.methods.agree);
  // beta: five authors with one commit each (tie -> first email), frank's copy.js
  // dominates blame, alice owns the most lines by hash
  assert.equal(beta.methods.commits.owner.email, 'frank@example.com');
  assert.equal(beta.methods.blame.owner.email, 'frank@example.com');
  assert.equal(beta.methods.hash.owner.email, ALICE);
  assert.ok(!beta.methods.agree);

  // A second run has nothing left to do and changes nothing.
  await blame({ dbPath: db });
  assert.deepEqual(withDb(db, (conn) => collectStats(conn)).methods, blamed.stats.methods);
});

function withDb(path, fn) {
  const conn = openDb(path);
  try {
    return fn(conn);
  } finally {
    conn.close();
  }
}
