#!/usr/bin/env node
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { blame } from '../src/blame.js';
import { readDefaultExcludes, readExcludeFile } from '../src/exclude.js';
import { add, index } from '../src/indexer.js';
import { report } from '../src/report.js';
import { summary } from '../src/summary.js';

const USAGE = `usage:
  ownh index --db <file> [--exclude-file <file>]... [--no-excludes] [--force] <repo>...
  ownh add --db <file> [--exclude-file <file>]... [--no-excludes] <repo>...
  ownh summary --db <file> [--top <n>]
  ownh report --db <file> [--out <dir>] [--top <n>] [--ai | --ai-dry-run] [--no-cache]   (default --out: report/<db name>/)
  ownh blame --db <file> [--jobs <n>] [--sample <files>] [--repo <name>]...

  Without --exclude-file, patterns come from ownh.exclude next to the tool,
  if it exists.
  --no-excludes indexes everything. add requires the same exclude list the
  .db was built with.

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
  or code changed. --no-cache recomputes without reading or writing it.`;

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

async function main([command, ...args]) {
  if (command === 'index') {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: { ...EXCLUDE_OPTIONS, force: { type: 'boolean', default: false } },
    });
    if (!values.db || positionals.length === 0) return usage();
    await index({ dbPath: values.db, repoPaths: positionals, excludes: excludesFrom(values), force: values.force, log });
  } else if (command === 'add') {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: EXCLUDE_OPTIONS });
    if (!values.db || positionals.length === 0) return usage();
    await add({ dbPath: values.db, repoPaths: positionals, excludes: excludesFrom(values), log });
  } else if (command === 'summary') {
    const { values } = parseArgs({
      args,
      options: {
        db: { type: 'string' },
        top: { type: 'string', default: '10' },
      },
    });
    const top = Number(values.top);
    if (!values.db || !Number.isInteger(top) || top < 1) return usage();
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
    if (!values.db || bad(jobs) || bad(sample)) return usage();
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
      },
    });
    const top = Number(values.top);
    if (!values.db || !Number.isInteger(top) || top < 1) return usage();
    // Each database gets its own report directory: report/<db name without .db>/.
    const out = values.out ?? join('report', basename(values.db).replace(/\.db$/, ''));
    const files = await report({ dbPath: values.db, outDir: out, top, log, ai: values.ai, aiDryRun: values['ai-dry-run'], cache: !values['no-cache'] });
    for (const file of files) log(`wrote ${out}/${file}`);
    if (values.ai || values['ai-dry-run']) log(`AI request (when one was made or prepared): ${out}/ai-request.json`);
  } else {
    usage();
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
