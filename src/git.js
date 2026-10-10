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

// Spawns git and returns its stdout plus `finish()`, which waits for exit and
// throws on a non-zero status. Callers must call finish() in a finally block: if
// the consumer stops early (an error, or a break), finish() kills the process, so
// it can't keep the event loop alive or block on a full pipe forever.
function run(repo, args, stdin) {
  const child = spawn('git', ['-C', repo, ...CONFIG, ...args], {
    stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
  const exited = new Promise((resolve) => {
    child.on('error', (err) => resolve({ err }));
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  if (stdin !== undefined) {
    // EPIPE when git exits before reading all input is reported via the exit status.
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  }
  let consumed = false;
  return {
    stdout: child.stdout,
    markConsumed: () => { consumed = true; },
    finish: async () => {
      if (!consumed && child.exitCode === null) child.kill();
      const { err, code } = await exited;
      if (!consumed) return; // abandoned early; the caller is already handling an error
      if (err) throw err;
      if (code !== 0) throw new Error(`git ${args[0]} failed in ${repo}: ${stderr.trim()}`);
    },
  };
}

// Splits on "\n" only. readline would also split on a lone "\r" and swallow the
// "\r" of CRLF lines, so diff lines and blob lines would hash differently.
// Pieces of a long line are collected in an array, so a multi-megabyte line
// (minified code) costs linear time, not one string copy per chunk.
async function* lines(stream) {
  const decoder = new StringDecoder('utf8');
  let pending = [];
  for await (const chunk of stream) {
    const text = decoder.write(chunk);
    let start = 0;
    let nl;
    while ((nl = text.indexOf('\n', start)) !== -1) {
      pending.push(text.slice(start, nl));
      yield pending.length === 1 ? pending[0] : pending.join('');
      pending = [];
      start = nl + 1;
    }
    if (start < text.length) pending.push(text.slice(start));
  }
  pending.push(decoder.end());
  const rest = pending.join('');
  if (rest) yield rest;
}

// Runs `args` and yields stdout lines; see run() for cleanup.
async function* gitLines(repo, args) {
  const proc = run(repo, args);
  try {
    yield* lines(proc.stdout);
    proc.markConsumed();
  } finally {
    await proc.finish();
  }
}

// Options that make the commit walk and the added lines independent of user
// config and of the exclude pathspecs:
//   --full-history     with any pathspec, git otherwise simplifies history and
//                      silently drops side-branch commits whose changes a merge
//                      did not keep, even when they touch no excluded file
//   --diff-algorithm   diff.algorithm in user config changes which lines a diff
//                      reports as added
export const WALK_OPTIONS = ['--full-history'];

// Full history of `rev`, oldest first, one patch per commit. Commit headers
// start with COMMIT_MARK followed by NUL-separated sha, author time (unix
// seconds), mailmapped author name and email, and parent shas.
//
// Merges are diffed with --diff-merges=remerge: git redoes the automatic merge
// and diffs it against the recorded result, so a merge's added lines are exactly
// what its author wrote by hand (conflict resolutions, changes no parent had).
// Taking one side of a conflict unchanged adds nothing.
export function log(repo, rev, pathspecs = []) {
  return gitLines(repo, [
    'log', '--reverse', '--topo-order', ...WALK_OPTIONS, '--root', '--diff-merges=remerge',
    '-p', '-M', '--full-index', '--unified=0', '--diff-algorithm=myers',
    '--no-color', '--no-ext-diff', '--no-textconv',
    '--no-relative', '--no-notes', '--use-mailmap',
    '--src-prefix=a/', '--dst-prefix=b/',
    `--format=${COMMIT_MARK}%H%x00%at%x00%aN%x00%aE%x00%P`,
    rev, '--', ...pathspecs,
  ]);
}

// `git blame --porcelain` of one file at `rev`. Returns Map(final line number ->
// { name, email }). The mailmap is read from `rev` (mailmap.blob), which works in
// the bare blame clones below and matches the .mailmap the history was indexed
// with unless it has uncommitted edits; a missing .mailmap is ignored. Porcelain
// prints author headers only the first time a commit appears, so they are
// remembered per commit.
const BLAME_HEADER = /^([0-9a-f]{40,64}) \d+ (\d+)/;

export async function blame(repo, rev, path) {
  const authors = new Map();
  const byCommit = new Map();
  let current = null;
  let line = 0;
  for await (const text of gitLines(repo, ['-c', `mailmap.blob=${rev}:.mailmap`, 'blame', '--porcelain', rev, '--', path])) {
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
// valid until the next iteration. Chunks of a large object are collected and
// joined once, so a big blob costs linear time.
export async function* catBlobs(repo, oids) {
  if (oids.length === 0) return;
  const proc = run(repo, ['cat-file', '--batch'], `${oids.join('\n')}\n`);
  try {
    let buf = Buffer.alloc(0);
    let parts = [];
    let partsLength = 0;
    let need = 0; // bytes needed in buf before parsing again; 0 = parse now
    for await (const chunk of proc.stdout) {
      if (need > 0) {
        parts.push(chunk);
        partsLength += chunk.length;
        if (buf.length + partsLength < need) continue;
        buf = Buffer.concat([buf, ...parts]);
        parts = [];
        partsLength = 0;
      } else {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      }
      need = 0;
      for (;;) {
        const nl = buf.indexOf(10);
        if (nl < 0) break;
        const [oid, type, size] = buf.toString('utf8', 0, nl).split(' ');
        if (type === 'missing') throw new Error(`object ${oid} missing in ${repo}`);
        const end = nl + 1 + Number(size);
        if (buf.length < end + 1) {
          need = end + 1;
          break;
        }
        yield buf.subarray(nl + 1, end);
        buf = buf.subarray(end + 1);
      }
    }
    proc.markConsumed();
  } finally {
    await proc.finish();
  }
}

// True for shallow clones, whose history stops at an arbitrary cut. Indexing one
// would hand every line older than the cut to the author of the boundary commit.
export function isShallow(repo) {
  return git(repo, ['rev-parse', '--is-shallow-repository']).trim() === 'true';
}
