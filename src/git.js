import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export const COMMIT_MARK = '\x01ownh ';

// Pin settings a user's git config could change in ways that break parsing.
const CONFIG = ['-c', 'log.showSignature=false', '-c', 'core.quotePath=false'];

export function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...CONFIG, ...args], {
    encoding: 'utf8',
    maxBuffer: 1 << 30,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function run(repo, args, stdin) {
  const child = spawn('git', ['-C', repo, ...CONFIG, ...args], {
    stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git ${args[0]} failed in ${repo}: ${stderr.trim()}`));
    });
  });
  if (stdin !== undefined) child.stdin.end(stdin);
  return { stdout: child.stdout, done };
}

// Splits on "\n" only. readline would also split on a lone "\r" and swallow the
// "\r" of CRLF lines, so diff lines and blob lines would hash differently.
async function* lines(stream) {
  const decoder = new StringDecoder('utf8');
  let rest = '';
  for await (const chunk of stream) {
    const parts = (rest + decoder.write(chunk)).split('\n');
    rest = parts.pop();
    for (const part of parts) yield part;
  }
  rest += decoder.end();
  if (rest) yield rest;
}

// Full history of `rev`, oldest first, one patch per non-merge commit. Commit
// headers start with COMMIT_MARK followed by NUL-separated sha, author time
// (unix seconds), mailmapped author name and email.
export async function* log(repo, rev, pathspecs = []) {
  const { stdout, done } = run(repo, [
    'log', '--reverse', '--topo-order', '--no-merges', '--root',
    '-p', '-M', '--full-index', '--unified=0', '--no-color', '--no-ext-diff', '--no-textconv',
    '--no-relative', '--no-notes', '--use-mailmap',
    '--src-prefix=a/', '--dst-prefix=b/',
    `--format=${COMMIT_MARK}%H%x00%at%x00%aN%x00%aE`,
    rev, '--', ...pathspecs,
  ]);
  yield* lines(stdout);
  await done;
}

// `git blame --porcelain` of one file at `rev`. Returns Map(final line number ->
// { name, email }). The mailmap is read from `rev` (mailmap.blob), which works in
// the bare blame clones below and matches the .mailmap the history was indexed
// with unless it has uncommitted edits; a missing .mailmap is ignored. Porcelain
// prints author headers only the first time a commit appears, so they are
// remembered per commit.
const BLAME_HEADER = /^([0-9a-f]{40,64}) \d+ (\d+)/;

export async function blame(repo, rev, path) {
  const { stdout, done } = run(repo, ['-c', `mailmap.blob=${rev}:.mailmap`, 'blame', '--porcelain', rev, '--', path]);
  const authors = new Map();
  const byCommit = new Map();
  let current = null;
  let line = 0;
  for await (const text of lines(stdout)) {
    if (text.startsWith('\t')) {
      authors.set(line, current);
      continue;
    }
    const m = BLAME_HEADER.exec(text);
    if (m) {
      if (!byCommit.has(m[1])) byCommit.set(m[1], { name: '', email: '' });
      current = byCommit.get(m[1]);
      line = Number(m[2]);
    } else if (text.startsWith('author ')) {
      current.name = text.slice(7);
    } else if (text.startsWith('author-mail ')) {
      current.email = text.slice(12).replace(/^<|>$/g, '');
    }
  }
  await done;
  return authors;
}

// A throwaway bare clone sharing `repo`'s objects, with a commit-graph and
// changed-path Bloom filters for `rev`'s history. git blame runs about 6x faster
// with them on a long history, and building them here leaves the user's repo
// untouched. Returns { path, dispose }.
export function blameClone(repo, rev) {
  const path = mkdtempSync(join(tmpdir(), 'ownh-blame-'));
  try {
    execFileSync('git', ['clone', '-q', '--bare', '--shared', repo, path], { stdio: ['ignore', 'ignore', 'pipe'] });
    execFileSync('git', ['-C', path, 'commit-graph', 'write', '--stdin-commits', '--changed-paths'], {
      input: `${rev}\n`,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
  } catch (err) {
    rmSync(path, { recursive: true, force: true });
    throw err;
  }
  return { path, dispose: () => rmSync(path, { recursive: true, force: true }) };
}

// Paths in `rev` that git treats as binary, using the same decision as the
// "Binary files differ" lines in log(): .gitattributes plus git's content check.
export function binaryPaths(repo, rev, pathspecs = []) {
  const out = git(repo, [
    'diff', '--numstat', '-z', '--no-renames', '--no-textconv', '--no-ext-diff', '--no-relative',
    emptyTree(repo), rev, '--', ...pathspecs,
  ]);
  const paths = new Set();
  for (const record of out.split('\0')) {
    if (record.startsWith('-\t-\t')) paths.add(record.slice(4));
  }
  return paths;
}

// Files in `rev` (no submodules), listed as a diff against the empty tree so the
// same pathspecs that filter log() filter this list.
export function headFiles(repo, rev, pathspecs = []) {
  const out = git(repo, [
    'diff', '--raw', '-z', '--no-abbrev', '--no-renames', '--no-relative',
    emptyTree(repo), rev, '--', ...pathspecs,
  ]);
  const fields = out.split('\0');
  const files = [];
  // Records are ":<old mode> <new mode> <old oid> <new oid> <status>" NUL <path> NUL.
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [, mode, , oid] = fields[i].split(' ');
    if (mode !== '160000') files.push({ oid, path: fields[i + 1] });
  }
  return files;
}

function emptyTree(repo) {
  return git(repo, ['hash-object', '-t', 'tree', '/dev/null']).trim();
}

// Yields the content of each object in `oids`, in order, as a Buffer that is only
// valid until the next iteration.
export async function* catBlobs(repo, oids) {
  if (oids.length === 0) return;
  const { stdout, done } = run(repo, ['cat-file', '--batch'], oids.join('\n') + '\n');
  let buf = Buffer.alloc(0);
  for await (const chunk of stdout) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      const nl = buf.indexOf(10);
      if (nl < 0) break;
      const [oid, type, size] = buf.toString('utf8', 0, nl).split(' ');
      if (type === 'missing') throw new Error(`object ${oid} missing in ${repo}`);
      const end = nl + 1 + Number(size);
      if (buf.length < end + 1) break;
      yield buf.subarray(nl + 1, end);
      buf = buf.subarray(end + 1);
    }
  }
  await done;
}
