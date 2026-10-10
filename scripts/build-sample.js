#!/usr/bin/env node
// Builds the sample report published at docs/sample/ from the demonstration
// repositories in demo-repos.js: fictional authors (@example.com), a seeded
// history, and fixed dates, so the output is real OWNH output, reproducible,
// and contains no real data.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blame } from '../src/blame.js';
import { index } from '../src/indexer.js';
import { report } from '../src/report.js';
import { buildDemoRepos } from './demo-repos.js';

const OUT = fileURLToPath(new URL('../docs/sample', import.meta.url));
// Kept after the build (git-ignored) for `summary`, `report`, and `report --ai`.
// The demonstration repositories themselves are temporary, so `blame` and
// `add` can't run against it later.
const DB = fileURLToPath(new URL('../report/sample.db', import.meta.url));

const dir = mkdtempSync(join(tmpdir(), 'ownh-sample-'));
try {
  console.log('building demonstration repositories');
  const repos = buildDemoRepos(dir);
  const db = DB;
  mkdirSync(dirname(db), { recursive: true });
  await index({ dbPath: db, repoPaths: repos, force: true, log: (m) => console.log(m) });
  await blame({ dbPath: db, jobs: 2 });
  // Keep the AI answer cache across rebuilds: unchanged data reuses the text
  // without an API call (or a key). AI is on when a cache exists or with --ai.
  const cachePath = join(OUT, 'ai-cache.json');
  const cache = existsSync(cachePath) ? readFileSync(cachePath, 'utf8') : null;
  rmSync(OUT, { recursive: true, force: true });
  if (cache) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(cachePath, cache);
  }
  // Without --ai, only cached AI text is used: a plain rebuild never calls the API.
  const request = process.argv.includes('--ai');
  const ai = Boolean(cache) || request;
  const files = await report({ dbPath: db, outDir: OUT, top: 15, ai, aiCacheOnly: !request, cache: false, log: (m) => m.startsWith('ai:') && console.log(m) });
  for (const file of files) console.log(`wrote docs/sample/${file}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
