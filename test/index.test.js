import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { openDb } from '../src/db.js';
import { toPathspecs } from '../src/exclude.js';
import { blame } from '../src/blame.js';
import { add, index } from '../src/indexer.js';
import { report } from '../src/report.js';
import { samplePaths } from '../src/sample.js';
import { collectStats, padText, textWidth } from '../src/stats.js';
import { findOddities } from '../src/oddities.js';
import { aiConfig, buildFacts, chatCompletion, checkAnswer, pseudonyms } from '../src/ai.js';
import { survivalStatements } from '../src/sections.js';
import { exampleLabels, findArchetypes } from '../src/archetypes.js';
import { parseCodeowners, patternRegex, ruleFor } from '../src/codeowners.js';
import { codeHash } from '../src/stagecache.js';
import { agentPseudonyms, agentSession, agentTools, ask } from '../src/agent.js';
import { buildTimeline, fitLine, nextRound, quarterLabel } from '../src/timeline.js';
import { summary } from '../src/summary.js';
import { catBlobs, log } from '../src/git.js';
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

test('never indexes a repo twice without force', async () => {
  const db = join(dir, 'exists.db');
  await index({ dbPath: db, repoPaths: [repos.alpha] });
  await assert.rejects(index({ dbPath: db, repoPaths: [repos.alpha] }), /already has a repo named "alpha"\. To index it again, rebuild the whole \.db with every repo it should hold: index --force with alpha/);
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

test('indexing into an existing database gives the same result as indexing everything at once', async () => {
  const full = join(dir, 'full.db');
  const added = join(dir, 'added.db');
  await index({ dbPath: full, repoPaths: [repos.alpha, repos.beta] });
  // beta first, so alpha gets the higher repo id; the heidi/ivan tie must still go to alpha
  await index({ dbPath: added, repoPaths: [repos.beta] });
  await index({ dbPath: added, repoPaths: [repos.alpha] });
  assert.deepEqual(owners(added), owners(full));
  assert.equal(owners(added)['beta/shared.js:2'], 'heidi@example.com');
  assert.equal(summary({ dbPath: added }), summary({ dbPath: full }));
});

test('appending refuses a different exclude list or a repo already present', async () => {
  const db = join(dir, 'add-guards.db');
  await index({ dbPath: db, repoPaths: [repos.beta], excludes: ['*.png'] });
  await assert.rejects(index({ dbPath: db, repoPaths: [repos.alpha], excludes: [] }), /exclude list differs/);
  await assert.rejects(index({ dbPath: db, repoPaths: [repos.beta] }), /already has a repo named "beta"/);
  await assert.rejects(add({ dbPath: join(dir, 'missing.db'), repoPaths: [repos.alpha] }), /does not exist/);
  // Without an exclude list, appending uses the stored one.
  await index({ dbPath: db, repoPaths: [repos.alpha] });
  const conn = openDb(db);
  const runs = conn.prepare('SELECT excludes FROM runs ORDER BY id').all().map((r) => JSON.parse(r.excludes));
  conn.close();
  assert.deepEqual(runs, [['*.png'], ['*.png']]);
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

test('a pseudonymized report names no committer and keeps the cache out', async () => {
  const db = join(dir, 'pseudo.db');
  const out = join(dir, 'pseudo');
  const cacheDir = join(dir, 'pseudo-cache');
  await index({ dbPath: db, repoPaths: [repos.alpha, repos.beta] });
  await report({ dbPath: db, outDir: out, cacheDir, top: 5, pseudonymize: true });
  assert.ok(!readdirSync(out).includes('stats-cache.json'));
  assert.ok(readdirSync(cacheDir).includes('stats-cache.json'));
  const conn = openDb(db);
  const people = conn.prepare('SELECT name, email FROM identities').all();
  conn.close();
  for (const file of readdirSync(out)) {
    const text = readFileSync(join(out, file), 'utf8');
    for (const { name, email } of people) {
      assert.ok(!text.includes(email), `${email} in ${file}`);
      assert.ok(!new RegExp(`\\b${name}\\b`).test(text), `${name} in ${file}`);
    }
  }
  const stats = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
  assert.equal(stats.owners[0].owner.name, 'Contributor 1');
});

test('ownership entropy: bits and effective owners per method', async () => {
  const { entropy } = await import('../src/stats.js');
  assert.equal(entropy(new Map([[1, 10]])).bits, 0);
  assert.equal(entropy(new Map([[1, 5], [2, 5], [3, 5], [4, 5]])).bits, 2);
  assert.equal(entropy(new Map([[1, 5], [2, 5], [null, 90]])).effectiveOwners, 2, 'unowned lines are left out');
  assert.equal(entropy(new Map()), null);
  const db = join(dir, 'entropy.db');
  await index({ dbPath: db, repoPaths: [repos.alpha, repos.beta] });
  const stats = withDb(db, (conn) => collectStats(conn));
  const lines = new Map(stats.owners.map((o) => [o.identityId, o.lines]));
  assert.ok(Math.abs(stats.methods.entropy.hash.bits - entropy(lines).bits) < 1e-9, 'same up to summation order');
  assert.ok(stats.methods.entropy.commits.bits > 0);
  assert.equal(stats.methods.entropy.blame, null, 'no blame run yet');
  for (const r of stats.repos) assert.ok(r.methods.entropy.hash.bits >= 0);
  // Line entropy per owner: lines and distinct lines add up to the HEAD lines.
  for (const o of stats.owners.filter((x) => x.owner)) {
    assert.equal(o.lineEntropy.lines, o.lines);
    assert.ok(o.lineEntropy.distinct >= 1 && o.lineEntropy.distinct <= o.lines);
    assert.ok(o.lineEntropy.bits >= 0 && o.lineEntropy.bits <= Math.log2(o.lineEntropy.distinct) + 1e-9);
  }
});

test('report files agree with the summary', async () => {
  const db = join(dir, 'report.db');
  const out = join(dir, 'report');
  await index({ dbPath: db, repoPaths: [repos.alpha, repos.beta] });
  await report({ dbPath: db, outDir: out, top: 5 });
  assert.deepEqual(readdirSync(out).sort(), [
    'blank-line-outlook.svg', 'code-survival.svg', 'cross-ownership.csv', 'cross-ownership.svg', 'leaderboard.md', 'lines.csv', 'methods.csv',
    'owner-composition.svg', 'owner-profile.svg', 'owner-shares.svg', 'owner-status.svg', 'owners.csv', 'ownership-by-line-hash.svg', 'ownership-outlook.svg', 'repo-profile.svg', 'report.html', 'report.json',
    'stats-cache.json',
  ]);
  // Stages are cached separately: a second run reuses all of them and writes
  // the same files; --no-cache reuses none; another --top recomputes only the
  // top lines; a blame run recomputes only the stages that read blame.
  const owners = readFileSync(join(out, 'owners.csv'), 'utf8');
  const runLog = async (opts) => {
    const lines = [];
    await report({ dbPath: db, outDir: out, top: 5, log: (m) => lines.push(m), ...opts });
    const m = /^stats: reused (.*); computed (.*)$/.exec(lines.find((l) => l.startsWith('stats: reused')) ?? '');
    return m ? m[2] : null;
  };
  assert.equal(await runLog({}), 'nothing');
  assert.equal(readFileSync(join(out, 'owners.csv'), 'utf8'), owners);
  assert.equal(await runLog({ cache: false }), 'head, lines, lineEntropy, blame, declared, history, deletions, survival');
  assert.equal(await runLog({ top: 4 }), 'lines');
  await blame({ dbPath: db });
  assert.equal(await runLog({ top: 4 }), 'blame, declared');
  const json = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
  assert.equal(json.generated.database, 'report.db');
  assert.match(json.generated.at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
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
  for (const svg of ['owner-shares.svg', 'owner-composition.svg', 'cross-ownership.svg', 'ownership-by-line-hash.svg', 'owner-profile.svg', 'repo-profile.svg', 'ownership-outlook.svg', 'blank-line-outlook.svg', 'code-survival.svg']) {
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

test('blame sampling gives an estimate, and a full run replaces it', async () => {
  const db = join(dir, 'sample.db');
  await index({ dbPath: db, repoPaths: [repos.alpha, repos.beta] });
  await blame({ dbPath: db, sample: 3 });

  const sampled = withDb(db, (conn) => ({
    files: conn.prepare("SELECT path FROM blame_files WHERE repo_id = (SELECT id FROM repos WHERE name = 'alpha')").all().map((r) => r.path),
    all: conn.prepare("SELECT DISTINCT path FROM head_lines WHERE repo_id = (SELECT id FROM repos WHERE name = 'alpha')").all().map((r) => r.path),
    stats: collectStats(conn),
  }));
  // Only the deterministic sample was blamed.
  assert.deepEqual(sampled.files.sort(), samplePaths(sampled.all, 3).sort());
  const alpha = sampled.stats.repos[0].methods.blame;
  assert.equal(alpha.estimate.files, 3);
  assert.equal(alpha.estimate.ofFiles, 6);
  assert.ok(alpha.estimate.margin >= 0);
  assert.equal(sampled.stats.methods.blame.estimate.margin, null); // overall: estimate, no margin
  assert.match(summary({ dbPath: db }), /~\d+\.\d% ±\d+\.\d/);

  // Without --sample the rest is blamed and the answer becomes exact.
  await blame({ dbPath: db });
  const full = withDb(db, (conn) => collectStats(conn));
  assert.equal(full.repos[0].methods.blame.estimate, undefined);
  assert.equal(full.repos[0].methods.blame.owner.email, ALICE);
});

test('samplePaths is deterministic and order-independent', () => {
  const paths = Array.from({ length: 50 }, (_, i) => `dir${i % 7}/file${i}.js`);
  const a = samplePaths(paths, 10);
  const b = samplePaths([...paths].reverse(), 10);
  assert.equal(a.length, 10);
  assert.deepEqual(a, b);
  assert.deepEqual(samplePaths(paths.slice(0, 5), 10).sort(), paths.slice(0, 5).sort());
});

test('excludes do not simplify away side-branch commits', async () => {
  // fiona writes "dup" on a branch at t=100 and removes it; mark adds the same
  // line on main at t=200; the merge keeps main's tree. With any pathspec, git's
  // default history simplification would drop fiona's commits entirely.
  const repo = init(dir, 'simplify');
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
  commit(repo, ['base', 'base@example.com'], 0, { 'a.txt': 'base\n' });
  git('checkout', '-q', '-b', 'feature');
  commit(repo, ['fiona', 'fiona@example.com'], 100, { 'b.txt': 'dup\n' });
  git('rm', '-q', 'b.txt');
  commit(repo, ['fiona', 'fiona@example.com'], 150, {});
  git('checkout', '-q', 'main');
  commit(repo, ['mark', 'mark@example.com'], 200, { 'c.txt': 'dup\n' });
  execFileSync('git', ['-C', repo, '-c', 'commit.gpgsign=false', 'merge', '-q', '--no-ff', 'feature', '-m', 'merge'], {
    stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_NAME: 'm', GIT_AUTHOR_EMAIL: 'm@example.com', GIT_COMMITTER_NAME: 'm', GIT_COMMITTER_EMAIL: 'm@example.com' },
  });
  const db = join(dir, 'simplify.db');
  await index({ dbPath: db, repoPaths: [repo], excludes: ['dist/'] });
  assert.equal(owners(db)['simplify/c.txt:1'], 'fiona@example.com');
});

test('shallow clones are refused', async () => {
  const shallow = join(dir, 'shallow');
  execFileSync('git', ['clone', '-q', '--depth', '1', `file://${repos.alpha}`, shallow], { stdio: 'ignore' });
  await assert.rejects(index({ dbPath: join(dir, 'shallow.db'), repoPaths: [shallow] }), /shallow clone/);
});

test('git streams: early exit kills git, failures propagate', async () => {
  const head = execFileSync('git', ['-C', repos.alpha, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  for await (const line of log(repos.alpha, head)) {
    assert.ok(line.length >= 0);
    break; // must not hang or leave git running
  }
  await assert.rejects(async () => {
    for await (const line of log(repos.alpha, 'no-such-rev')) assert.ok(line);
  }, /git log failed/);
});

test('catBlobs returns large blobs intact', async () => {
  const repo = init(dir, 'bigblob');
  const big = Buffer.alloc(5 * 1024 * 1024 + 7, 'x');
  big[123] = 10;
  writeFileSync(join(repo, 'big.txt'), big);
  writeFileSync(join(repo, 'small.txt'), 'small\n');
  const oids = ['big.txt', 'small.txt', 'big.txt'].map((f) =>
    execFileSync('git', ['-C', repo, 'hash-object', '-w', f], { encoding: 'utf8' }).trim());
  const got = [];
  for await (const content of catBlobs(repo, oids)) got.push(Buffer.from(content));
  assert.equal(got.length, 3);
  assert.ok(got[0].equals(big));
  assert.equal(got[1].toString(), 'small\n');
  assert.ok(got[2].equals(big));
});

test('oddities are derived from the stats', async () => {
  const db = join(dir, 'odd.db');
  await index({ dbPath: db, repoPaths: [repos.alpha, repos.beta] });
  await blame({ dbPath: db });
  const odd = findOddities(withDb(db, (conn) => collectStats(conn, { topLines: 10 })));
  const kinds = odd.map((o) => o.kind);
  assert.deepEqual(kinds, ['trivial-top-line', 'trivial-lines', 'crlf-twin', 'crlf-twin', 'binary-duplicate', 'absentee-owner', 'demolition', 'restored']);
  // carol's reindent removed two of bob's lines; erin's revert brought alice's line back
  assert.match(odd.find((o) => o.kind === 'demolition').title, /^Carol has removed 2 lines that belonged to others$/);
  assert.match(odd.find((o) => o.kind === 'restored').title, /^1 line was added again after being deleted$/);
  // beta's top line-hash owner is Alice, who never committed to beta
  assert.equal(odd.find((o) => o.kind === 'absentee-owner').title, '1 of 2 repositories is owned by someone who never committed to it');
  const text = (o) => o.detail.map((p) => p.code ?? p.text).join('');
  assert.match(text(odd.find((o) => o.kind === 'crlf-twin')), /"}" belongs to Alice and "}\\r" .* to Judy/);
});

test('timeline math: fit, milestones, projections', () => {
  const fit = fitLine([0, 1, 2, 3], [1, 3, 5, 7]);
  assert.equal(fit.slope, 2);
  assert.equal(fit.intercept, 1);
  assert.equal(fit.r2, 1);
  assert.deepEqual([0, 1, 999, 1000, 4999].map(nextRound), [1, 2, 1000, 2000, 5000]);
  assert.equal(quarterLabel(2026 * 4 + 2), '2026 Q3');

  // Twelve quarters; the principal writes 1 of every 4 new lines at first and
  // more each quarter, so the share climbs steadily toward a majority.
  const q0 = 2024 * 4;
  const cohorts = [];
  const commitQuarters = [];
  for (let i = 0; i < 12; i++) {
    cohorts.push({ repoId: 1, identityId: 1, q: q0 + i, n: 10 + 3 * i });
    cohorts.push({ repoId: 1, identityId: 2, q: q0 + i, n: 30 });
    commitQuarters.push({ identityId: 1, q: q0 + i }, { identityId: 2, q: q0 + i });
  }
  const t = buildTimeline({
    cohorts,
    commitQuarters,
    blankByQuarter: commitQuarters.filter((c) => c.identityId === 1).map(({ q }) => ({ q, n: 100 })),
    contributed: new Set(['1:1', '1:2']),
    principal: { identityId: 1, owner: { name: 'P', email: 'p@example.com' } },
  });
  assert.equal(t.nowLabel, '2026 Q4');
  assert.equal(t.projections.principal.status, 'projected');
  assert.ok(t.projections.principal.fit.slope > 0);
  assert.equal(t.projections.knowledgeLoss.current, 0); // everyone committed this quarter
  assert.equal(t.projections.blank.current, 1200);
  assert.equal(t.projections.blank.milestone, 2000);
  assert.equal(t.projections.blank.quarter, '2028 Q4'); // 100 per quarter: 2000th in quarter 20
  assert.equal(t.kpis.length, 8);
  assert.equal(t.kpis.at(-1).lines, cohorts.reduce((a, c) => a + c.n, 0));
});

test('merge authors own the lines they wrote while merging', async () => {
  const repo = init(dir, 'merging');
  const env = (name, time) => ({
    ...process.env,
    GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: `${name}@example.com`, GIT_AUTHOR_DATE: `${1_700_000_000 + time} +0000`,
    GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: `${name}@example.com`, GIT_COMMITTER_DATE: `${1_700_000_000 + time} +0000`,
  });
  const git = (args, name = 'base', time = 0) =>
    execFileSync('git', ['-C', repo, '-c', 'commit.gpgsign=false', '-c', 'merge.ff=false', ...args], { stdio: 'ignore', env: env(name, time) });
  commit(repo, ['base', 'base@example.com'], 0, { 'f.txt': 'a\nb\nc\n', 'g.txt': 'x\n', 'h.txt': 'k\n' });
  git(['checkout', '-q', '-b', 'feat']);
  commit(repo, ['fiona', 'fiona@example.com'], 100, { 'f.txt': 'a\nFEAT\nc\n', 'g.txt': 'y\n' });
  git(['checkout', '-q', 'main']);
  commit(repo, ['mark', 'mark@example.com'], 200, { 'f.txt': 'a\nMAIN\nc\n', 'g.txt': 'z\n' });
  try { git(['merge', '-q', 'feat'], 'merger', 300); } catch { /* conflicts are expected */ }
  writeFileSync(join(repo, 'f.txt'), 'a\nRESOLVED BY HAND\nc\n'); // a new line written in the merge
  writeFileSync(join(repo, 'g.txt'), 'y\n'); // fiona's side taken unchanged
  writeFileSync(join(repo, 'h.txt'), 'k\nEVIL\n'); // a change no parent had
  git(['add', '-A'], 'merger', 300);
  git(['commit', '-q', '-m', 'merge'], 'merger', 300);

  const db = join(dir, 'merging.db');
  await index({ dbPath: db, repoPaths: [repo] });
  const o = owners(db);
  assert.equal(o['merging/f.txt:2'], 'merger@example.com');
  assert.equal(o['merging/h.txt:2'], 'merger@example.com');
  assert.equal(o['merging/g.txt:1'], 'fiona@example.com');
  assert.ok(!Object.values(o).includes(null)); // nothing unattributed

  // The merge is not a commit for counting purposes.
  const stats = withDb(db, (conn) => collectStats(conn));
  assert.equal(stats.owners.find((x) => x.owner?.email === 'merger@example.com').commits, 0);
  assert.equal(stats.repos[0].methods.commits.total, 3);
});

test('AI prose: pseudonymized facts, number guard, names mapped back, cache', async () => {
  const db = join(dir, 'ai.db');
  await index({ dbPath: db, repoPaths: [repos.alpha, repos.beta] });
  const stats = withDb(db, (conn) => collectStats(conn));
  const p = pseudonyms(stats);
  const facts = JSON.stringify(buildFacts(stats, findArchetypes(stats), p));
  // No owner name, email, or repository name leaves the machine.
  for (const o of stats.owners.filter((x) => x.owner)) {
    assert.ok(!facts.includes(o.owner.name) && !facts.includes(o.owner.email), o.owner.name);
  }
  for (const r of stats.repos) assert.ok(!facts.includes(`"${r.name}"`), r.name);
  // No absolute counts and no calendar dates: sizes are bands, quarters tokens.
  assert.ok(!facts.includes(String(stats.total)), 'no line total');
  assert.ok(!/\b(19|20)\d\d\b/.test(facts), 'no years');
  assert.match(facts, /"lines":"tens"|"lines":"under a thousand"/);
  assert.ok(facts.includes('"now":"[T0]"'));
  // Tokens are numbered by first appearance: contiguous from 1, so the highest
  // number is just how many were mentioned, not how many exist.
  for (const prefix of ['O', 'R']) {
    const used = [...new Set([...facts.matchAll(new RegExp(`\\[${prefix}(\\d+)\\]`, 'g'))].map((m) => Number(m[1])))].sort((a, b) => a - b);
    assert.deepEqual(used, used.map((_, i) => i + 1), `${prefix} tokens contiguous`);
  }
  // Group sizes are words, never a percentage of the owner count.
  assert.ok(!facts.includes('ownersPct'));
  assert.match(facts, /"owners":"(one owner|no owners|all owners|(under a tenth|under a quarter|under half|about half|over half|over three quarters) of owners)"/);
  // Count-based shares are words, never numbers that could be reversed.
  assert.match(facts, /"methodsAgreeIn":"(no repositories|all repositories|(under a tenth|under a quarter|under half|about half|over half|over three quarters) of repositories)"/);
  // Archetype rules sent to the model contain no number derived from the data.
  const sentRules = JSON.parse(facts).archetypes.map((a) => a.rule).join(' ');
  assert.ok(!/at least \d+ lines/.test(sentRules), sentRules);
  // Only quarter tokens issued in the facts are known; invented ones are not.
  assert.ok(p.known('[T0]'));
  assert.ok(!p.known('[T+7]'), 'an invented quarter is rejected');
  // Quarter tokens map back to real quarters locally.
  assert.equal(p.unmap('by [T0]'), `by ${stats.timeline.nowLabel}`);

  // A dry run writes the exact request and sends nothing.
  const dry = join(dir, 'ai-dry');
  let sent = 0;
  await report({ dbPath: db, outDir: dry, aiDryRun: true, aiEnv: { OPENROUTER_API_KEY: 'k' }, complete: async () => { sent++; return '{}'; } });
  assert.equal(sent, 0);
  const request = JSON.parse(readFileSync(join(dry, 'ai-request.json'), 'utf8'));
  assert.deepEqual(request.body.provider, { data_collection: 'deny', zdr: true });
  assert.deepEqual(request.headers, ['authorization: Bearer <key>', 'content-type: application/json']);
  assert.ok(!JSON.stringify(request).includes(stats.owners[0].owner.email));

  const env = { OWNH_AI_KEY: 'test', OWNH_AI_MODEL: 'test/model' };
  let calls = 0;
  const answer = (f, bad) => JSON.stringify({
    summary: [
      `[O1] leads with ${bad ? 4242 : f.topOwners[0].sharePct}% of ${f.scale.lines} lines across [R1] and [R2], as of [T0].`,
      'Stewardship remains concentrated.',
      'The board can expect continuity.',
    ],
    okr: {
      objective: 'Consolidate code ownership.',
      keyResults: [
        { text: `Hold [O1] above ${f.topOwners[0].sharePct}%.`, status: 'on track' },
        { text: 'Grow stewardship in [R2].', status: 'at risk' },
        { text: 'Reduce absentee ownership.', status: 'off track' },
      ],
    },
    archetypes: Object.fromEntries(f.archetypes.map((a) => [a.key, `The ${a.key} guild`])),
  });
  const factsOf = (messages) => JSON.parse(messages[1].content.replace(/^Facts \(JSON\):\n/, ''));

  // First reply has a number that is not in the facts: rejected, then fixed.
  const out = join(dir, 'ai-report');
  await report({ dbPath: db, outDir: out, ai: true, aiEnv: env, complete: async (_c, messages) => answer(factsOf(messages), ++calls === 1) });
  assert.equal(calls, 2);
  const md = readFileSync(join(out, 'leaderboard.md'), 'utf8');
  const top = stats.owners.find((o) => o.owner).owner.name;
  assert.ok(md.includes(`## AI insights`) && md.includes(`${top} leads with`), 'tokens mapped back to names');
  assert.ok(!/\[[OR]\d+\]/.test(md), 'no tokens left');
  assert.ok(md.includes('## OKR draft (AI-generated)') && md.includes('The principal guild (AI)'));
  // AI-written parts are marked: sparkle icon on both AI headings and every AI archetype name.
  const html = readFileSync(join(out, 'report.html'), 'utf8');
  for (const id of ['ai-insights', 'okr-draft']) {
    assert.match(html, new RegExp(`id="${id}"><h2><svg class="r-sparkle"`));
  }
  assert.ok(html.includes('</svg> <b>The principal guild</b>'), 'AI archetype name has the sparkle icon');

  // Same data again: answered from the cache, no request.
  await report({ dbPath: db, outDir: out, ai: true, aiEnv: env, complete: async () => { calls++; return '{}'; } });
  assert.equal(calls, 2);

  // A model that never gets the numbers right is withheld, not printed.
  const out2 = join(dir, 'ai-report-2');
  await report({ dbPath: db, outDir: out2, ai: true, aiEnv: env, complete: async (_c, messages) => answer(factsOf(messages), true) });
  assert.match(readFileSync(join(out2, 'leaderboard.md'), 'utf8'), /## AI insights \(AI-generated\)\n\nWithheld: the model's text failed verification/);
});

test('AI API: temperature fallback, and failures withhold instead of aborting', async () => {
  const realFetch = globalThis.fetch;
  const bodies = [];
  try {
    // A model that only accepts its default temperature.
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if ('temperature' in body) {
        return new Response(JSON.stringify({ error: { message: "Unsupported value: 'temperature' does not support 0 with this model.", param: 'temperature' } }), { status: 400 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
    };
    const config = aiConfig({ OWNH_AI_KEY: 'k', OWNH_AI_BASE_URL: 'https://api.example.com/v1' });
    assert.equal(await chatCompletion(config, [{ role: 'user', content: 'hi' }]), 'ok');
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].temperature, 0);
    assert.ok(!('temperature' in bodies[1]));
    assert.ok(!('provider' in bodies[0]), 'no OpenRouter routing fields for other APIs');
    assert.equal(aiConfig({ OWNH_AI_TEMPERATURE: 'default' }).temperature, null);

    // A local endpoint without a key: no authorization header at all. The
    // default (hosted) endpoint still requires a key.
    let headers = null;
    globalThis.fetch = async (_url, init) => {
      headers = init.headers;
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
    };
    const local = aiConfig({ OWNH_AI_BASE_URL: 'http://localhost:11434/v1' });
    assert.equal(local.requireKey, false);
    assert.equal(await chatCompletion(local, [{ role: 'user', content: 'hi' }]), 'ok');
    assert.ok(!('authorization' in headers));
    assert.equal(aiConfig({}).requireKey, true);

    const db = join(dir, 'ai-fail.db');
    await index({ dbPath: db, repoPaths: [repos.alpha] });
    const env = { OWNH_AI_KEY: 'k', OWNH_AI_BASE_URL: 'https://api.example.com/v1' };

    // After a temperature fallback, ai-request.json shows the request that was
    // actually sent: without temperature.
    globalThis.fetch = async (_url, init) => ('temperature' in JSON.parse(init.body)
      ? new Response('{"error": {"message": "temperature unsupported"}}', { status: 400 })
      : new Response(JSON.stringify({ choices: [{ message: { content: 'not json' } }] }), { status: 200 }));
    const fallback = join(dir, 'ai-fallback');
    await report({ dbPath: db, outDir: fallback, ai: true, aiEnv: env });
    assert.ok(!('temperature' in JSON.parse(readFileSync(join(fallback, 'ai-request.json'), 'utf8')).body));

    // Any other API error: the report is still written, the AI sections are withheld.
    globalThis.fetch = async () => new Response('{"error": {"message": "invalid key"}}', { status: 401 });
    const out = join(dir, 'ai-fail');
    await report({ dbPath: db, outDir: out, ai: true, aiEnv: env });
    assert.match(readFileSync(join(out, 'leaderboard.md'), 'utf8'), /Withheld: AI request failed: HTTP 401 \{"error": \{"message": "invalid key"\}\}/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('table columns pad by visible characters, not UTF-16 units', () => {
  const combining = 'Fo\u0308rmat'; // "o" + combining diaeresis, as some git authors store it
  assert.equal(textWidth(combining), 6);
  assert.equal(padText(combining, 8), `${combining}  `);
  assert.equal(padText('F\u00f6rmat', 8, true), '  F\u00f6rmat');
});

test('archetype examples tell apart identities that share a name', () => {
  const owners = [
    { name: 'Fiona Format', email: 'fiona@old.example' },
    { name: 'Ada Lindqvist', email: 'ada@example.com' },
    { name: 'Fiona Format', email: 'fiona@new.example' },
  ];
  assert.deepEqual(exampleLabels(owners), ['Fiona Format <fiona@old.example>', 'Ada Lindqvist', 'Fiona Format <fiona@new.example>']);
});

test('the newest quarter is labeled in progress when the report is generated inside it', async () => {
  const db = join(dir, 'partial.db');
  await index({ dbPath: db, repoPaths: [repos.alpha, repos.beta] });
  const done = join(dir, 'partial-done');
  await report({ dbPath: db, outDir: done });
  const now = JSON.parse(readFileSync(join(done, 'report.json'), 'utf8')).timeline.now;
  assert.doesNotMatch(readFileSync(join(done, 'leaderboard.md'), 'utf8'), /in progress/);

  const saved = process.env.SOURCE_DATE_EPOCH;
  process.env.SOURCE_DATE_EPOCH = String(Date.UTC(Math.floor(now / 4), (now % 4) * 3, 10) / 1000);
  try {
    const partial = join(dir, 'partial-now');
    await report({ dbPath: db, outDir: partial });
    const md = readFileSync(join(partial, 'leaderboard.md'), 'utf8');
    assert.match(md, new RegExp(`\\| ${Math.floor(now / 4)} Q${(now % 4) + 1} \\(in progress\\) +\\|`));
    assert.match(md, /was still in progress when this report was generated/);
  } finally {
    if (saved === undefined) delete process.env.SOURCE_DATE_EPOCH;
    else process.env.SOURCE_DATE_EPOCH = saved;
  }
});

test('indexing edge cases: raw bytes, binary/text switches, repo paths, submodules, odd paths', async () => {
  const A = ['Fiona Format', 'fiona@example.com'];
  const B = ['Ada Lindqvist', 'ada@example.com'];
  const repo = init(dir, 'edges');
  // Non-UTF-8 bytes: two Latin-1 lines that differ in one byte.
  commit(repo, A, 100, { 'latin1-a.txt': Buffer.from('caf\xe9\n', 'latin1'), 'bin.dat': Buffer.from([1, 0, 2, 10]), 'gone.txt': 'p\nq\n', 'my file.txt': 'spaced\n' });
  commit(repo, B, 200, { 'latin1-b.txt': Buffer.from('caf\xe8\n', 'latin1'), 'bin.dat': 'one\ntwo\n', 'gone.txt': Buffer.from([0, 1, 2]) });
  // A gitlink (submodule entry) added, then deleted.
  const env = (t) => ({ ...process.env, GIT_AUTHOR_NAME: B[0], GIT_AUTHOR_EMAIL: B[1], GIT_COMMITTER_NAME: B[0], GIT_COMMITTER_EMAIL: B[1], GIT_AUTHOR_DATE: `${1_700_000_000 + t} +0000`, GIT_COMMITTER_DATE: `${1_700_000_000 + t} +0000` });
  const sha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', repo, 'update-index', '--add', '--cacheinfo', `160000,${sha},sub`], { env: env(300) });
  execFileSync('git', ['-C', repo, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'add gitlink'], { env: env(300) });
  execFileSync('git', ['-C', repo, 'rm', '-q', '--cached', 'sub'], { env: env(400) });
  execFileSync('git', ['-C', repo, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'drop gitlink'], { env: env(400) });
  execFileSync('git', ['-C', repo, 'checkout', '-q', '--', '.']);
  mkdirSync(join(repo, 'sub-dir'));

  // Given as a subdirectory: the repo is still named for its root.
  const db = join(dir, 'edges.db');
  await index({ dbPath: db, repoPaths: [join(repo, 'sub-dir')] });
  const own = owners(db);
  assert.equal(own['edges/latin1-a.txt:1'], A[1]);
  assert.equal(own['edges/latin1-b.txt:1'], B[1], 'a different non-UTF-8 byte is a different line');
  assert.equal(own['edges/bin.dat:1'], B[1], 'binary rewritten as text: its lines get an owner');
  assert.equal(own['edges/bin.dat:2'], B[1]);
  withDb(db, (conn) => {
    assert.equal(conn.prepare("SELECT COUNT(*) AS n FROM churn ch LEFT JOIN line_hashes l ON l.hash = ch.hash WHERE l.hash IS NULL").get().n, 0, 'no churn for unowned hashes (gitlinks)');
    // Text rewritten as binary: its text lines count as removed.
    const removed = conn.prepare("SELECT SUM(ch.removed) AS n FROM churn ch JOIN line_hashes l ON l.hash = ch.hash WHERE l.text IN ('p', 'q')").get().n;
    assert.equal(removed, 2);
    assert.equal(conn.prepare("SELECT COUNT(*) AS n FROM line_hashes WHERE path LIKE '%' || char(9)").get().n, 0, 'no trailing tab on paths with spaces');
    assert.ok(conn.prepare("SELECT 1 FROM line_hashes WHERE path = 'my file.txt'").get());
  });

  // Given as its .git directory: same name, same result; --force replaces the .db.
  await index({ dbPath: db, repoPaths: [join(repo, '.git')], force: true });
  assert.deepEqual(owners(db), own);
  assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith('edges.db.building')), []);

  // blame on a missing .db fails without creating it.
  await assert.rejects(blame({ dbPath: join(dir, 'typo.db') }), /does not exist/);
  assert.ok(!readdirSync(dir).includes('typo.db'));
});

test('report fixes: full demolition rule, Markdown escaping, code spans, survival text', async () => {
  // Net demolishers come from every owner's own count, not the top-10 list.
  const fdb = join(dir, 'demolition.db');
  await index({ dbPath: fdb, repoPaths: [repos.alpha, repos.beta] });
  const stats = withDb(fdb, (conn) => collectStats(conn));
  const expected = stats.owners.filter((o) => o.owner && (o.removedOthers ?? 0) > o.lines).length;
  const demolition = findArchetypes(stats).find((a) => a.key === 'demolition');
  assert.equal(demolition?.members ?? 0, expected);
  assert.ok(stats.owners.every((o) => o.identityId === null || typeof o.removedOthers === 'number'));

  // Untrusted names and line text cannot become Markdown markup.
  const A = ['*Fiona* _Format_ [x](y)', 'fiona@example.com'];
  const repo = init(dir, 'escapes');
  commit(repo, A, 100, { 'e.js': 'a``b\na``b\na``b\n' });
  const db = join(dir, 'escapes.db');
  await index({ dbPath: db, repoPaths: [repo] });
  const out = join(dir, 'escapes-report');
  await report({ dbPath: db, outDir: out, cache: false });
  const md = readFileSync(join(out, 'leaderboard.md'), 'utf8');
  assert.ok(md.includes('\\*Fiona\\* \\_Format\\_ \\[x\\](y) \\<fiona@example.com\\>'));
  assert.ok(!md.includes('| *Fiona*'));
  assert.ok(md.includes('```"a``b"```'), 'a code span fence longer than any backtick run inside');

  // Deletions with all history in one quarter: no claim that nothing was deleted.
  const text = survivalStatements({ survival: { all: { lines: 10, curve: [0.9], halfLife: null, projected: false }, owners: [] } });
  assert.match(text[0], /90\.0% of lines survive; not enough history/);
  assert.match(survivalStatements({ survival: { all: { lines: 10, curve: [1, 1], halfLife: null, projected: false }, owners: [] } })[0], /no lines have been deleted/);
});

test('AI number guard: values only, and spelled-out numbers', () => {
  const facts = { scale: { repositories: 'fewer than ten' }, outlook: { r2: 0.9 }, archetypes: [] };
  const p = { known: () => true };
  const answer = (s) => ({ summary: [s, 'b', 'c'], okr: { objective: 'o', keyResults: [{ text: 'k', status: 'on track' }, { text: 'k', status: 'on track' }, { text: 'k', status: 'on track' }] }, archetypes: {} });
  assert.match(checkAnswer(answer('Growth of 2 points.'), facts, p).join(), /the number 2 is not in the facts/, 'key names like r2 are not facts');
  assert.match(checkAnswer(answer('Twelve quarters ahead.'), facts, p).join(), /"Twelve" is not in the facts/);
  assert.deepEqual(checkAnswer(answer('Fewer than ten repositories, R² 0.9.'), facts, p), []);
  // A malformed key result is a problem to report, not a crash.
  const bad = answer('x');
  bad.okr.keyResults[1] = null;
  assert.match(checkAnswer(bad, facts, p).join(), /each key result/);
});

test('CODEOWNERS patterns follow GitHub rules', () => {
  const m = (pattern, path) => patternRegex(pattern).test(path);
  assert.ok(m('*', 'a/b/c.js'));
  assert.ok(m('*.js', 'a/b.js') && !m('*.js', 'a/b.ts'));
  assert.ok(m('/docs/*', 'docs/a.md') && !m('/docs/*', 'docs/sub/b.md'), 'a wildcard last segment stays at its level');
  assert.ok(m('docs/*', 'docs/a.md') && !m('docs/*', 'x/docs/a.md'), 'a slash inside anchors at the root');
  assert.ok(m('apps/', 'x/apps/y/z.js') && !m('apps/', 'apps'), 'dir/ matches contents at any depth');
  assert.ok(m('/apps/github', 'apps/github/a.js') && m('/apps/github', 'apps/github'));
  assert.ok(m('**/logs', 'logs/a') && m('**/logs', 'a/b/logs/c') && !m('**/logs', 'catalogs/x'));
  assert.ok(m('/build/**', 'build/a/b') && !m('/build/**', 'x/build/a'));
  const rules = parseCodeowners('# comment\n* @org/all\n\n[Section]\n/docs/* @org/docs # inline\nsrc/ @org/src\n/vendor/\nmy\\ dir/ a@example.com\n');
  assert.deepEqual(rules.map((r) => [r.pattern, r.owners]), [['*', ['@org/all']], ['/docs/*', ['@org/docs']], ['src/', ['@org/src']], ['/vendor/', []], ['my dir/', ['a@example.com']]]);
  assert.equal(rules[ruleFor(rules, 'docs/sub/x.md')].pattern, '*', 'the last matching rule wins');
  assert.equal(rules[ruleFor(rules, 'src/a.js')].pattern, 'src/');
  assert.deepEqual(parseCodeowners('/docs/* @x').length, 1);
});

test('declared ownership: CODEOWNERS next to line hash and blame', async () => {
  const A = ['Fiona Format', 'fiona@example.com'];
  const B = ['Ada Lindqvist', 'ada@example.com'];
  const repo = init(dir, 'declared');
  mkdirSync(join(repo, '.github'));
  mkdirSync(join(repo, 'src'));
  mkdirSync(join(repo, 'docs'));
  mkdirSync(join(repo, 'docs', 'sub'));
  commit(repo, A, 100, {
    '.github/CODEOWNERS': '* @org/all\n/docs/* @org/docs\nsrc/ @org/src\n/vendor/\n',
    'src/a.js': 'alpha();\nbeta();\n',
    'docs/x.md': 'x\n',
    'docs/sub/y.md': 'y\n',
  });
  commit(repo, B, 200, { 'src/b.js': 'gamma();\ndelta();\nepsilon();\n' });
  const db = join(dir, 'declared.db');
  await index({ dbPath: db, repoPaths: [repo] });
  await blame({ dbPath: db });
  const stats = withDb(db, (conn) => collectStats(conn));
  const d = stats.repos[0].declared;
  assert.equal(d.file, '.github/CODEOWNERS');
  const byPattern = Object.fromEntries(d.rules.map((r) => [r.pattern, r]));
  assert.equal(byPattern['src/'].lines, 5);
  assert.equal(byPattern['src/'].hash.owner.email, 'ada@example.com');
  assert.equal(byPattern['src/'].blame.owner.email, 'ada@example.com');
  assert.deepEqual(byPattern['src/'].owners, ['@org/src']);
  assert.equal(byPattern['/docs/*'].lines, 1, 'docs/sub/y.md falls back to "*"');
  assert.equal(byPattern['*'].lines, 4 + 1, 'CODEOWNERS itself and docs/sub/y.md');
  assert.equal(d.noRule, 0);
  assert.equal(d.unmatchedRules, 1, '/vendor/ matches nothing');
  assert.deepEqual(d.unmatched, ['/vendor/']);
  assert.deepEqual(d.shadowed, []);
  const unmatched = findOddities(stats).find((o) => o.kind === 'declared-unmatched');
  assert.match(unmatched.title, /^1 CODEOWNERS rule matches no file, in 1 repository$/);
  assert.deepEqual(unmatched.detail.filter((p) => p.code).map((p) => p.code), ['/vendor/']);

  const out = join(dir, 'declared-report');
  await report({ dbPath: db, outDir: out, cache: false });
  const md = readFileSync(join(out, 'leaderboard.md'), 'utf8');
  assert.match(md, /## Declared ownership/);
  assert.match(md, /\| `src\/` +\| @org\/src +\| +5 \| Ada Lindqvist \(60\.0%\) +\| Ada Lindqvist \(60\.0%\) +\|/);
  assert.ok(readdirSync(out).includes('codeowners.csv'));
  assert.match(readFileSync(join(out, 'codeowners.csv'), 'utf8'), /,'@org\/src,/, 'handles cannot become spreadsheet formulas');
  assert.deepEqual(parseCodeowners('\\\n* @x').map((r) => r.pattern), ['*'], 'a lone backslash line is skipped');
  assert.match(readFileSync(join(out, 'report.html'), 'utf8'), /id="declared-ownership"/);
  // A rule a later rule overrides everywhere is not "no file".
  const shadowRepo = init(dir, 'declared-shadow');
  commit(shadowRepo, A, 100, { CODEOWNERS: '* @org/first\n* @org/second\n. @org/dot\n', 'x.js': 'x();\n' });
  const sdb = join(dir, 'declared-shadow.db');
  await index({ dbPath: sdb, repoPaths: [shadowRepo] });
  const sd = withDb(sdb, (conn) => collectStats(conn)).repos[0].declared;
  assert.deepEqual(sd.shadowed, ['*']);
  assert.deepEqual(sd.unmatched, ['.']);
  assert.deepEqual(sd.rules.map((r) => r.owners), [['@org/second']]);
  // Paths and team names never reach the AI facts.
  assert.ok(!JSON.stringify(buildFacts(stats, findArchetypes(stats), pseudonyms(stats))).includes('@org'));
});

test('stage code hash follows imports and re-exports', () => {
  const mods = mkdtempSync(join(tmpdir(), 'ownh-code-'));
  try {
    writeFileSync(join(mods, 'a.js'), "import { b } from './b.js';\nexport const a = b;\n");
    writeFileSync(join(mods, 'b.js'), "export { c as b } from './c.js';\n");
    writeFileSync(join(mods, 'c.js'), 'export const c = 1;\n');
    writeFileSync(join(mods, 'other.js'), 'export const other = 1;\n');
    const url = new URL(`file://${join(mods, 'a.js')}`);
    const before = codeHash(url);
    writeFileSync(join(mods, 'other.js'), 'export const other = 2;\n');
    assert.equal(codeHash(url), before, 'a module nothing imports does not count');
    writeFileSync(join(mods, 'c.js'), 'export const c = 2;\n');
    assert.notEqual(codeHash(url), before, 'a change two imports away does');
  } finally {
    rmSync(mods, { recursive: true, force: true });
  }
});

test('agent: tools and questions are pseudonymized, answers mapped back', async () => {
  const db = join(dir, 'agent.db');
  await index({ dbPath: db, repoPaths: [repos.alpha, repos.beta] });
  const stats = withDb(db, (conn) => collectStats(conn));
  const secrets = [
    ...stats.owners.filter((o) => o.owner).flatMap((o) => [o.owner.email, o.owner.name]),
    ...stats.repos.map((r) => r.name), 'a.js', 'shared.js',
  ];
  const leaks = (text) => secrets.filter((s) => new RegExp(`(?<![\\w@.-])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w@-])`, 'i').test(text));

  const session = agentSession(stats, aiConfig({ OWNH_AI_BASE_URL: 'http://localhost:1/v1' }), null);
  for (const [name, handler] of Object.entries(session.handlers)) {
    const args = name === 'owner_profile' ? { owner: session.p.owner(stats.owners[0].owner) } : name === 'codeowners' ? {} : {};
    assert.deepEqual(leaks(JSON.stringify(handler(args))), [], `tool ${name} leaks a name`);
  }
  const top = stats.owners[0].owner;
  assert.equal(session.p.question(`How much does ${top.name} own in alpha?`).includes(top.name), false);

  // Two owners with one display name: both tokens in questions, emails in answers.
  const twins = { ...stats, owners: [{ owner: { name: 'Fiona Format', email: 'f1@example.com' } }, { owner: { name: 'Fiona Format', email: 'f2@example.com' } }], repos: [] };
  const tp = agentPseudonyms(twins);
  const asked = tp.question('What does Fiona Format own?');
  assert.match(asked, /^What does \[O\d+\] or \[O\d+\] own\?$/);
  assert.equal(tp.unmap(asked), 'What does Fiona Format <f1@example.com> or Fiona Format <f2@example.com> own?');

  // Time-scoped tools read the database: over all quarters they agree with the
  // stats, and their results are pseudonymized too.
  withDb(db, (conn) => {
    const timed = agentSession(stats, aiConfig({ OWNH_AI_BASE_URL: 'http://localhost:1/v1' }), null, { db: conn });
    const all = timed.handlers.removals({ from_quarter: '1970 Q1', to_quarter: '2100 Q4' });
    assert.equal(all.lines_removed, stats.deletions.removed);
    assert.equal(all.lines_removed_owned_by_others, stats.deletions.removedOfOthers);
    const act = timed.handlers.activity({ from_date: '1970-01-01', to_date: '2100-12-31' });
    assert.equal(act.commits, conn.prepare('SELECT COUNT(*) AS n FROM commits WHERE is_merge = 0').get().n);
    assert.deepEqual(leaks(JSON.stringify([all, act])), []);
    assert.throws(() => timed.handlers.removals({ from_quarter: 'last month', to_quarter: '2026 Q1' }), /expected a quarter/);
    assert.ok(timed.messages[0].content.includes('Today is '));
  });

  const sent = [];
  const realFetch = globalThis.fetch;
  let round = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    sent.push(init.body);
    round++;
    if (round === 1) {
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'owners', arguments: '{"limit": 3}' } }] } }] }), { status: 200 });
    }
    // The tool result came back as a tool message; answer with its first token.
    const tool = body.messages.find((m) => m.role === 'tool');
    const first = JSON.parse(tool.content).owners[0].owner;
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `${first} owns the most lines.` } }] }), { status: 200 });
  };
  try {
    const answer = await ask(session, `Who owns the most lines? Is it ${top.name}?`);
    assert.equal(answer, `${top.name} owns the most lines.`);
    assert.equal(round, 2);
    for (const body of sent) assert.deepEqual(leaks(body), [], 'a request leaks a name');
    assert.ok(JSON.parse(sent[0]).tools.some((t) => t.function.name === 'owner_profile'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('bot detection: [bot] accounts, tools, and bot or robot as a word in the name', async () => {
  const { isBot } = await import('../src/oddities.js');
  const bot = (name, email = 'x@example.com') => isBot({ name, email });
  for (const n of ['depbot[bot]', 'Fiona Build Bot', 'docs-bot', 'Petra Robot', 'BOT', 'renovate', 'Release Automation']) assert.ok(bot(n), n);
  for (const n of ['Fiona Format', 'Ada Lindqvist', 'Abbot Costa', 'Robotham Lee', 'fionabot', 'Automationist Lee']) assert.ok(!bot(n), n);
  // The most varied lines among the top owners belong to automation.
  const { findOddities } = await import('../src/oddities.js');
  const owner = (name, lines, distinct, bits) => ({ owner: { name, email: `${name.split(' ')[0].toLowerCase()}@example.com` }, lines, lineEntropy: { lines, distinct, bits } });
  const odd = findOddities({ owners: [owner('Ada Lindqvist', 900, 40, 4.1), owner('Release Automation', 300, 280, 8.0), owner('Mira Quist', 200, 150, 7.0)], lines: [], repos: [], methods: {}, deletions: null, timeline: null });
  const hit = odd.find((o) => o.kind === 'bot-line-entropy');
  assert.match(hit.title, /belong to Release Automation/);
  assert.match(hit.detail[0].text, /Ada Lindqvist, holds 900 lines at 4\.1 bits \(40 distinct lines\)/);
  assert.ok(bot('Petra Process', '49699333+dependabot[bot]@users.noreply.github.com'));
});

test('declared ownership: compact table only when one rule decides every line', async () => {
  const { declaredSimple, declaredDetailed } = await import('../src/sections.js');
  const repo = (name, rules, noRule) => ({ name, declared: { rules: Array.from({ length: rules }, () => ({})), noRule } });
  const stats = { repos: [repo('a', 1, 0), repo('b', 1, 500), repo('c', 0, 10), repo('d', 3, 0)] };
  assert.deepEqual(declaredSimple(stats).map((r) => r.name), ['a']);
  assert.deepEqual(declaredDetailed(stats).map((r) => r.name), ['b', 'c', 'd']);
});

test('agent question filter: everyone known, exact case for one-word names, plain-word repos only when marked', () => {
  const stats = { owners: [{ owner: { name: 'Fiona Format', email: 'fiona@example.com' }, lines: 5 }], repos: [{ name: 'tools' }, { name: 'billing-api' }] };
  const people = [
    { owner: { name: 'Fiona Format', email: 'fiona@example.com' }, aliases: ['ff'] },
    { owner: { name: 'Mark', email: 'mark@example.com' }, aliases: [] },
    { owner: { name: 'Ada Lindqvist', email: 'ada@example.com' }, aliases: [] }, // owns no lines
  ];
  const p = agentPseudonyms(stats, people);
  const q = p.question('Did Ada Lindqvist or Mark mark the tools in billing-api, repo tools, or `tools`? ff?');
  assert.doesNotMatch(q, /Ada|Lindqvist|billing-api|\bMark\b|\bff\b/);
  assert.match(q, /mark the tools in \[R\d+\], repo \[R\d+\], or `\[R\d+\]`/, 'ordinary words survive');
  const tools = agentTools(stats, p);
  assert.equal(tools.handlers.owners({ limit: null }).owners.length, 1, 'limit null means the default');
  assert.equal(tools.handlers.owner_profile({ owner: p.owner(people[2].owner) }).lines_owned, 0);
});

test('agent question filter: shared surnames, possessives, mentions, and known paths', () => {
  const o = (name, email) => ({ name, email });
  const stats = {
    owners: [], lines: [{ path: 'assets/logo.png', binary: true }],
    repos: [{ name: 'billing-api', owners: [], declared: { rules: [{ pattern: '/src/payments/', owners: ['@acme/payments-team'] }], unmatched: ['/legacy/'], shadowed: [] } }],
  };
  const people = [
    { owner: o('Ada Quill', 'ada@old.example.com'), aliases: [] },
    { owner: o('Ada Quill', 'ada@new.example.com'), aliases: [] },
    { owner: o('Bram Okonkwo', 'bram@example.com'), aliases: [] },
    { owner: o('Cy Smith-Jones', 'cy@example.com'), aliases: [] },
    { owner: o('Mark', 'mark@example.com'), aliases: [] },
  ];
  const p = agentPseudonyms(stats, people);
  const q = (text) => p.question(text);
  assert.match(q('what does quill own'), /^what does \[O\d+\] or \[O\d+\] own$/);
  assert.doesNotMatch(q("Okonkwo's lines and okonkwo-style code"), /okonkwo/i);
  assert.doesNotMatch(q('ask @Mark and @Bram Okonkwo'), /Mark|Bram|Okonkwo/);
  assert.doesNotMatch(q('who did smith-jones replace'), /smith|jones/i);
  assert.doesNotMatch(q('who owns /src/payments/ for @acme/payments-team, /legacy/, or assets/logo.png'), /payments|legacy|logo/);
});

test('pseudonymized names: any case, every name an email committed under, handles in text, bots', async () => {
  const { pseudonymizeStats } = await import('../src/pseudonymize.js');
  const ada = { name: 'Ada Lindqvist', email: 'ada@example.com' };
  const stats = {
    owners: [{ owner: ada, lines: 3 }, { owner: { name: 'Petra Bot', email: 'petra@example.com' }, lines: 1 }, { owner: { name: 'depbot[bot]', email: 'depbot[bot]@example.com' }, lines: 1 }],
    lines: [{ text: '// (c) ADA LINDQVIST <Ada@Example.com>, A. Old-Name Lindqvist, ask @adal', owner: ada }],
    repos: [{ name: 'r', declared: { rules: [{ pattern: '*', owners: ['@adal'] }] } }],
  };
  const out = pseudonymizeStats(stats, { aliases: new Map([['ada@example.com', new Set(['A. Old-Name Lindqvist'])]]) });
  assert.equal(out.lines[0].text, '// (c) Contributor 1 <contributor-1@example.invalid>, Contributor 1, ask @user-1');
  assert.deepEqual(out.owners[1].owner, { name: 'Petra Bot', email: 'automation-1@example.invalid' });
  assert.deepEqual(out.owners[2].owner, stats.owners[2].owner);
  // Tens of thousands of names would overflow one regex.
  const many = Array.from({ length: 20000 }, (_, i) => ({ owner: { name: `Person${i} Surname${i}`, email: `p${i}@example.com` }, lines: 1 }));
  assert.doesNotThrow(() => pseudonymizeStats({ owners: many, lines: [{ text: 'PERSON7 SURNAME7' }] }));
});

test('paths that are not UTF-8 stay distinct', async () => {
  const { pathText } = await import('../src/git.js');
  const bytes = (b) => Buffer.from(b).toString('latin1');
  assert.equal(pathText(bytes([0x63, 0x61, 0x66, 0xe9])), 'caf\\xe9');
  assert.equal(pathText(bytes([0x63, 0x61, 0x66, 0xe8])), 'caf\\xe8');
  assert.equal(pathText(bytes(Buffer.from('café/ö.txt'))), 'café/ö.txt');
});

test('agent: partial names are matched per question and found by find', () => {
  const stats = { owners: [{ owner: { name: 'Petra Ströbel', email: 'petra@example.com' }, lines: 50, commits: 3, lastCommit: null }], repos: [] };
  const people = [
    { owner: { name: 'Petra Ströbel', email: 'petra@example.com' }, aliases: [] },
    { owner: { name: 'Juno Rasmussen', email: 'juno@example.com' }, aliases: [] },
    { owner: { name: 'Pavel Rasmussen', email: 'pavel@example.com' }, aliases: [] },
    { owner: { name: 'Mark', email: 'mark@example.com' }, aliases: [] },
  ];
  const p = agentPseudonyms(stats, people);
  // One person's surname, any case, accents ignored: replaced. Two people's
  // surname, a one-word name in the wrong case, and short words: left alone.
  const q = p.question('what did strobel do, and rasmussen, and did they mark it?');
  assert.match(q, /^what did \[O\d+\] do, and rasmussen, and did they mark it\?$/);
  const { handlers } = agentTools(stats, p);
  const found = handlers.find({ query: 'rasmus' });
  assert.equal(found.people.length, 2);
  assert.ok(found.people.every((x) => /^\[O\d+\]$/.test(x.person) && x.match === 'partial'));
  const exact = handlers.find({ query: 'petra ströbel' });
  assert.equal(exact.people[0].match, 'exact');
  assert.equal(exact.people[0].lines_owned, 50);
  assert.ok(!JSON.stringify(found).includes('Rasmussen'), 'results carry tokens, not names');
  const typo = handlers.find({ query: 'rasmusen' });
  assert.equal(typo.people.length, 2);
  assert.ok(typo.people.every((x) => x.match === 'similar'));
  assert.equal(handlers.find({ query: 'zzzzzz' }).people.length, 0);
});

test('agent: find matches repository names, parts, and typos, returning tokens', () => {
  const stats = { owners: [], repos: [{ name: 'billing-service', lines: 10 }, { name: 'api-gateway', lines: 30 }, { name: 'platform', lines: 50 }] };
  const p = agentPseudonyms(stats, []);
  const { handlers } = agentTools(stats, p);
  const find = (q) => handlers.find({ query: q }).repositories;
  assert.equal(find('platform')[0].match, 'exact');
  assert.equal(find('gateway')[0].match, 'word');
  assert.equal(find('bill')[0].match, 'partial');
  assert.deepEqual(find('platfrom').map((r) => r.match), ['similar']);
  assert.equal(find('nothing-like-it').length, 0);
  assert.equal(find('the gateway thing')[0].match, 'word', 'a phrase is tried word by word');
  assert.ok(find('gateway').every((r) => /^\[R\d+\]$/.test(r.repo)));
});

test('agent: colors only on a terminal and never with NO_COLOR', async () => {
  const { agentBanner, useColor } = await import('../src/agent.js');
  const tty = { isTTY: true };
  assert.equal(useColor(tty, {}), true);
  assert.equal(useColor(tty, { NO_COLOR: '1' }), false);
  assert.equal(useColor(tty, { NO_COLOR: '' }), true, 'an empty NO_COLOR does not count');
  assert.equal(useColor({ isTTY: false }, {}), false);
  assert.doesNotMatch(agentBanner('1.0.1', false), /\x1b/);
  assert.match(agentBanner('1.0.1', true), /\x1b\[/);
});

test('agent: owners can be ranked by kind of line', () => {
  const owner = (name, lines, composition) => ({ owner: { name, email: `${name}@example.com` }, lines, commits: 1, composition });
  const stats = { owners: [owner('Ada', 100, { blank: 60, punctuation: 30, code: 10, binary: 0 }), owner('Juno', 80, { blank: 0, punctuation: 5, code: 75, binary: 0 })], repos: [], total: 180 };
  const p = agentPseudonyms(stats, null);
  const { handlers } = agentTools(stats, p);
  const code = handlers.owners({ rank_by: 'code' });
  assert.equal(code.code_lines_total, 85);
  assert.equal(code.owners[0].owner, p.owner(stats.owners[1].owner));
  assert.equal(code.owners[0].code_lines, 75);
  assert.equal(handlers.owners({ rank_by: 'punctuation' }).owners[0].punctuation_lines, 30);
  assert.equal(handlers.owners({}).ranked_by, 'lines owned');
});

test('agent: owners in one repository can be ranked by kind of line', async () => {
  const db = join(dir, 'agent-kinds.db');
  await index({ dbPath: db, repoPaths: [repos.alpha, repos.beta] });
  const stats = withDb(db, (conn) => collectStats(conn));
  const alpha = stats.repos.find((r) => r.name === 'alpha');
  // Per-repo composition adds up to each owner's lines there.
  for (const o of alpha.owners.filter((x) => x.owner)) {
    assert.equal(Object.values(o.composition).reduce((a, b) => a + b, 0), o.lines);
  }
  const p = agentPseudonyms(stats, null);
  const { handlers } = agentTools(stats, p);
  const r = handlers.owners({ repo: p.repo('alpha'), rank_by: 'code' });
  const expected = alpha.owners.filter((o) => o.owner && o.composition.code > 0).sort((a, b) => b.composition.code - a.composition.code || (a.owner.email < b.owner.email ? -1 : 1))[0];
  assert.equal(r.owners[0].owner, p.owner(expected.owner));
  assert.equal(r.code_lines_total, alpha.owners.reduce((t, o) => t + (o.composition?.code ?? 0), 0));
});
