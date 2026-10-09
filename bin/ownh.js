#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { blame } from '../src/blame.js';
import { DEFAULT_EXCLUDE_FILE, readExcludeFile } from '../src/exclude.js';
import { add, index } from '../src/indexer.js';
import { report } from '../src/report.js';
import { summary } from '../src/summary.js';

const USAGE = `usage:
  ownh index --db <file> [--exclude-file <file>]... [--no-excludes] [--force] <repo>...
  ownh add --db <file> [--exclude-file <file>]... [--no-excludes] <repo>...
  ownh summary --db <file> [--top <n>]
  ownh report --db <file> --out <dir> [--top <n>]
  ownh blame --db <file> [--jobs <n>] [--sample <files>] [--repo <name>]...

  Without --exclude-file, patterns come from ownh.exclude next to the tool.
  --no-excludes indexes everything. add requires the same exclude list the
  .db was built with.`;

const EXCLUDE_OPTIONS = {
  db: { type: 'string' },
  'exclude-file': { type: 'string', multiple: true },
  'no-excludes': { type: 'boolean', default: false },
};

const log = (msg) => process.stderr.write(`${msg}\n`);

function excludesFrom(values) {
  const files = values['no-excludes'] ? [] : (values['exclude-file'] ?? [DEFAULT_EXCLUDE_FILE]);
  return files.flatMap(readExcludeFile);
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
      },
    });
    const top = Number(values.top);
    if (!values.db || !values.out || !Number.isInteger(top) || top < 1) return usage();
    for (const file of report({ dbPath: values.db, outDir: values.out, top, log })) log(`wrote ${values.out}/${file}`);
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
