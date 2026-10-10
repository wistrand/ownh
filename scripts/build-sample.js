#!/usr/bin/env node
// Builds the sample report published at docs/sample/ from the demonstration
// repositories in demo-repos.js: fictional authors (@example.com), a seeded
// history, and fixed dates, so the output is real OWNH output, reproducible,
// and contains no real data.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blame } from '../src/blame.js';
import { index } from '../src/indexer.js';
import { report } from '../src/report.js';
import { buildDemoRepos } from './demo-repos.js';

const OUT = fileURLToPath(new URL('../docs/sample', import.meta.url));

const dir = mkdtempSync(join(tmpdir(), 'ownh-sample-'));
try {
  console.log('building demonstration repositories');
  const repos = buildDemoRepos(dir);
  const db = join(dir, 'sample.db');
  await index({ dbPath: db, repoPaths: repos, log: (m) => console.log(m) });
  await blame({ dbPath: db, jobs: 2 });
  rmSync(OUT, { recursive: true, force: true });
  for (const file of report({ dbPath: db, outDir: OUT, top: 15 })) console.log(`wrote docs/sample/${file}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
