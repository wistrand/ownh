import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
import { aiConfig, buildFacts, chatCompletion, pseudonyms } from '../src/ai.js';
import { exampleLabels, findArchetypes } from '../src/archetypes.js';
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
  await report({ dbPath: db, outDir: out, top: 5 });
  assert.deepEqual(readdirSync(out).sort(), [
    'blank-line-outlook.svg', 'code-survival.svg', 'cross-ownership.csv', 'cross-ownership.svg', 'leaderboard.md', 'lines.csv', 'methods.csv',
    'owner-profile.svg', 'owners.csv', 'ownership-by-line-hash.svg', 'ownership-outlook.svg', 'repo-profile.svg', 'report.html', 'report.json',
    'stats-cache.json',
  ]);
  // A second run reuses the computed stats and writes the same files; another
  // --top or --no-cache recomputes.
  const owners = readFileSync(join(out, 'owners.csv'), 'utf8');
  const runLog = async (opts) => {
    const lines = [];
    await report({ dbPath: db, outDir: out, top: 5, log: (m) => lines.push(m), ...opts });
    return lines.some((m) => m.startsWith('stats: reused'));
  };
  assert.equal(await runLog({}), true);
  assert.equal(readFileSync(join(out, 'owners.csv'), 'utf8'), owners);
  assert.equal(await runLog({ cache: false }), false);
  assert.equal(await runLog({ top: 4 }), false);
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
  for (const svg of ['cross-ownership.svg', 'ownership-by-line-hash.svg', 'owner-profile.svg', 'repo-profile.svg', 'ownership-outlook.svg', 'blank-line-outlook.svg', 'code-survival.svg']) {
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
