#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { blame } from '../src/blame.js';
import { DEFAULT_EXCLUDE_FILE, readDefaultExcludes, readExcludeFile } from '../src/exclude.js';
import { add, index } from '../src/indexer.js';
import { cachedStats, report } from '../src/report.js';
import { aiConfig } from '../src/ai.js';
import { agentBanner, runAgent, useColor } from '../src/agent.js';
import { quarterOf } from '../src/quarters.js';
import { openDb } from '../src/db.js';
import { summary } from '../src/summary.js';
import { git } from '../src/git.js';
import { fileURLToPath } from 'node:url';

const USAGE = `usage:
  ownh index [--db <file>] [--exclude-file <file>]... [--no-excludes] [--force] <repo>...
  ownh summary [--db <file>] [--top <n>]
  ownh report [--db <file>] [--out <dir>] [--top <n>] [--ai | --ai-dry-run] [--no-cache] [--pseudonymize]
      (default --out: report/<db name>/, or report/<db name>-pseudonymized/)
  ownh blame [--db <file>] [--jobs <n>] [--sample <files>] [--repo <name>]...
  ownh agent [--db <file>] [--out <dir>] [--top <n>]   (ask questions about the database; same AI settings as --ai)
  ownh update   (git pull the checkout this command runs from)
  ownh info     (where this command and its source are, version, git commit)

  Without --db, commands use ownh.db in the current directory; only index
  creates it.

  index creates the .db, or adds the repos to an existing one; the result is
  the same as indexing them all at once. A repo already in the .db is
  refused; --force rebuilds the .db from the repos given.

  Without --exclude-file, patterns come from ownh.exclude next to the tool,
  if it exists. --no-excludes indexes everything. Adding to an existing .db
  uses the exclude list it was built with; an explicit list must match it.

  --ai adds AI-written prose (summary, OKR draft, archetype names) via any
  OpenAI-compatible chat API, hosted or local: OWNH_AI_KEY or
  OPENROUTER_API_KEY (not needed with a keyless OWNH_AI_BASE_URL such as a
  local server); optional OWNH_AI_MODEL (default openai/gpt-6-luna),
  OWNH_AI_TEMPERATURE (a number, default 0, or "default" to send none), and
  OWNH_AI_ZDR=0 to drop the zero-data-retention requirement. Only percentages, size
  bands, and tokens for names and quarters are sent; the exact request is
  written to ai-request.json. --ai-dry-run writes that file and sends nothing.

  report caches its statistics passes in stats-cache.json in the output
  directory, each pass on its own, and reruns only those whose database tables
  or code changed. --no-cache recomputes without reading or writing it.

  --pseudonymize replaces committer names and emails with "Contributor N" in
  every report file, and CODEOWNERS handles with "@user-N" and "@team-N".
  Bots keep their names. Names inside line text are replaced only for known
  emails and names of more than one word. The stats cache stays in
  report/<db name>/, since it holds real names.`;

const EXCLUDE_OPTIONS = {
  db: { type: 'string' },
  'exclude-file': { type: 'string', multiple: true },
  'no-excludes': { type: 'boolean', default: false },
};

const log = (msg) => process.stderr.write(`${msg}\n`);

// An --exclude-file that doesn't exist is an error; a missing default
// ownh.exclude just means no excludes.
function excludesFrom(values) {
  if (values['no-excludes']) return [];
  if (values['exclude-file']) return values['exclude-file'].flatMap(readExcludeFile);
  const defaults = readDefaultExcludes();
  if (defaults === null) {
    log('no ownh.exclude next to the tool; nothing is excluded');
    return [];
  }
  return defaults;
}

// Without --db, every command uses ownh.db in the current directory and says
// so on stderr. Only `index` may create it; the others need it to exist.
const DEFAULT_DB = 'ownh.db';
function dbFrom(values, { create = false } = {}) {
  if (values.db) return values.db;
  if (!create && !existsSync(DEFAULT_DB)) {
    throw new Error(`no ${DEFAULT_DB} here; run \`ownh index <repo>...\` or pass --db`);
  }
  log(`using ./${DEFAULT_DB}`);
  return DEFAULT_DB;
}

async function main([command, ...args]) {
  // `add` is the old name for appending; it still works but is not listed,
  // and unlike index it never creates a .db.
  if (command === 'index' || command === 'add') {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: { ...EXCLUDE_OPTIONS, ...(command === 'index' ? { force: { type: 'boolean', default: false } } : {}) },
    });
    if (positionals.length === 0) return usage();
    values.db = dbFrom(values, { create: command === 'index' });
    const appending = existsSync(values.db) && !values.force;
    // Appending without exclude flags uses the .db's own list (null), so a
    // changed ownh.exclude does not block it.
    const explicit = values['no-excludes'] || values['exclude-file'];
    const excludes = appending && !explicit ? null : excludesFrom(values);
    await (command === 'add' ? add : index)({ dbPath: values.db, repoPaths: positionals, excludes, force: values.force, log });
  } else if (command === 'summary') {
    const { values } = parseArgs({
      args,
      options: {
        db: { type: 'string' },
        top: { type: 'string', default: '10' },
      },
    });
    const top = Number(values.top);
    if (!Number.isInteger(top) || top < 1) return usage();
    values.db = dbFrom(values);
    process.stdout.write(summary({ dbPath: values.db, top, log }));
  } else if (command === 'blame') {
    const { values } = parseArgs({
      args,
      options: {
        db: { type: 'string' },
        jobs: { type: 'string' },
        repo: { type: 'string', multiple: true },
        sample: { type: 'string' },
      },
    });
    const int = (v) => (v === undefined ? undefined : Number(v));
    const jobs = int(values.jobs);
    const sample = int(values.sample);
    const bad = (n) => n !== undefined && (!Number.isInteger(n) || n < 1);
    if (bad(jobs) || bad(sample)) return usage();
    values.db = dbFrom(values);
    await blame({ dbPath: values.db, repoNames: values.repo ?? [], jobs, sample, log });
  } else if (command === 'report') {
    const { values } = parseArgs({
      args,
      options: {
        db: { type: 'string' },
        out: { type: 'string' },
        top: { type: 'string', default: '20' },
        ai: { type: 'boolean', default: false },
        'ai-dry-run': { type: 'boolean', default: false },
        'no-cache': { type: 'boolean', default: false },
        pseudonymize: { type: 'boolean', default: false },
      },
    });
    const top = Number(values.top);
    if (!Number.isInteger(top) || top < 1) return usage();
    values.db = dbFrom(values);
    // Each database gets its own report directory: report/<db name without .db>/.
    // A pseudonymized report goes next to it and shares its stats cache, which
    // holds real names and so never goes into the pseudonymized directory.
    const dir = join('report', basename(values.db).replace(/\.db$/, ''));
    const pseudonymize = values.pseudonymize;
    const out = values.out ?? (pseudonymize ? `${dir}-pseudonymized` : dir);
    const files = await report({ dbPath: values.db, outDir: out, cacheDir: pseudonymize ? dir : out, top, log, ai: values.ai, aiDryRun: values['ai-dry-run'], cache: !values['no-cache'], pseudonymize });
    for (const file of files) log(`wrote ${out}/${file}`);
    if (values.ai || values['ai-dry-run']) log(`AI request (when one was made or prepared): ${out}/ai-request.json`);
  } else if (command === 'info') {
    info();
  } else if (command === 'update') {
    selfUpdate();
  } else if (command === 'agent') {
    const { values } = parseArgs({
      args,
      options: {
        db: { type: 'string' },
        out: { type: 'string' },
        top: { type: 'string', default: '20' },
      },
    });
    const top = Number(values.top);
    if (!Number.isInteger(top) || top < 1) return usage();
    values.db = dbFrom(values);
    if (!existsSync(values.db)) throw new Error(`${values.db} does not exist`);
    const config = aiConfig(process.env);
    if (!config.key && config.requireKey) throw new Error('no API key: set OWNH_AI_KEY or OPENROUTER_API_KEY, or OWNH_AI_BASE_URL for a keyless endpoint');
    // Same directory and stats cache as `report`, so a reported database starts fast.
    const out = values.out ?? join('report', basename(values.db).replace(/\.db$/, ''));
    mkdirSync(out, { recursive: true });
    // On a terminal: the logo first, then one progress line that is replaced
    // as the stats load (stage-by-stage lines only when something is computed).
    const tty = process.stdout.isTTY;
    if (tty) process.stdout.write(agentBanner(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version));
    const dim = useColor() ? (m) => `\x1b[2m${m}\x1b[0m` : (m) => m;
    const status = (msg) => (tty ? process.stdout.write(`\r\x1b[2K${dim(msg.slice(0, (process.stdout.columns || 80) - 1))}`) : log(msg));
    const stats = cachedStats({ dbPath: values.db, outDir: out, top, log: (m) => { if (!/^stats: \w+: cached$/.test(m)) status(m); }, cache: true });
    if (tty) process.stdout.write('\r\x1b[2K');
    if (stats.timeline) stats.timeline.inProgress = quarterOf(Date.now() / 1000) === stats.timeline.now;
    // Read-only connection for the time-scoped tools, open for the session.
    const db = openDb(values.db);
    try {
      await runAgent({ stats, config, outDir: out, db });
    } finally {
      db.close();
    }
  } else {
    usage();
  }
}

// `ownh update`: fast-forward the git checkout this command runs from (the
// installer's ~/.ownh clone, or any clone). Node resolves the installer's
// symlink, so import.meta.url is inside the checkout itself.
// `ownh info`: where this command and its source are, and what version.
function info() {
  const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const invoked = process.argv[1];
  const real = realpathSync(invoked);
  const out = [
    `OWNH ${version}`,
    `command:  ${invoked}${real !== invoked ? ` -> ${real}` : ''}`,
    `source:   ${root}`,
  ];
  const ask = (args) => {
    try { return git(root, args).trim(); } catch { return null; }
  };
  const top = ask(['rev-parse', '--show-toplevel']);
  if (top && realpathSync(top) === realpathSync(root)) {
    const commit = ask(['log', '-1', '--format=%h %cd', '--date=short']);
    const branch = ask(['rev-parse', '--abbrev-ref', 'HEAD']);
    const remote = ask(['remote', 'get-url', 'origin']);
    const dirty = ask(['status', '--porcelain', '--untracked-files=no']);
    out.push(`git:      ${commit ?? '?'} on ${branch ?? '?'}${dirty ? ' (local changes)' : ''}${remote ? `, from ${remote}` : ''}`);
  } else {
    out.push('git:      not a git checkout (ownh update needs one)');
  }
  out.push(
    `node:     ${process.version}`,
    `excludes: ${DEFAULT_EXCLUDE_FILE}${existsSync(DEFAULT_EXCLUDE_FILE) ? '' : ' (not present)'}`,
  );
  // Installed by docs/install.sh: the command is a symlink to the checkout.
  if (lstatSync(invoked).isSymbolicLink()) out.push(`uninstall: rm -rf ${root} ${invoked}`);
  process.stdout.write(`${out.join('\n')}\n`);
}

function selfUpdate() {
  const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
  let before;
  let top;
  try {
    before = git(root, ['rev-parse', '--short', 'HEAD']).trim();
    top = git(root, ['rev-parse', '--show-toplevel']).trim();
  } catch {
    throw new Error(`${root} is not a git checkout; reinstall with: curl -fsSL https://ownh.org/install.sh | sh`);
  }
  // A copy of OWNH inside some other repository must not pull that repository.
  if (realpathSync(top) !== realpathSync(root)) {
    throw new Error(`${root} is inside another git repository (${top}), not an OWNH checkout; reinstall with: curl -fsSL https://ownh.org/install.sh | sh`);
  }
  try {
    git(root, ['pull', '--ff-only', '--quiet']);
  } catch (err) {
    // git prints hints first; the reason is the "fatal:" line.
    const lines = (err.stderr || err.message).toString().trim().split('\n');
    throw new Error(`update failed in ${root}: ${(lines.find((l) => l.startsWith('fatal:')) ?? lines[0]).replace(/^fatal: /, '')}`);
  }
  const after = git(root, ['rev-parse', '--short', 'HEAD']).trim();
  if (after === before) {
    log(`Already up to date (${after}).`);
  } else {
    const n = git(root, ['rev-list', '--count', `${before}..${after}`]).trim();
    log(`Updated ${before} -> ${after} (${n} ${n === '1' ? 'commit' : 'commits'}).`);
  }
}

function usage() {
  process.stderr.write(`${USAGE}\n`);
  process.exitCode = 2;
}

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`ownh: ${err.message}\n`);
  process.exitCode = 1;
});
