// Per-stage cache for collectStats. Each expensive stage is stored under its
// own key, so a change recomputes only the stages it can affect:
//
//   code  a hash of the stage's module and every local module it imports,
//         found by following its import statements (codeHash). Computed when
//         stats.js loads, so it describes the code this process runs.
//   data  a fingerprint of the database tables the stage reads (stats.js):
//         completed index runs for everything, plus the blame state for the
//         stages that read blame.
//   args  stage arguments that change its result (--top, survival's owners).
//
// Stage values are stored as JSON and always passed through JSON, fresh or
// cached, so a cached run renders exactly what a fresh run would.
import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

const IMPORT = /^\s*(?:import|export)\s[^;]*?from\s+'(\.{1,2}\/[^']+)'|^\s*import\s+'(\.{1,2}\/[^']+)'/gm;

// sha256 over the source of `url` and, recursively, of every relative module
// it imports or re-exports, each file once, in a fixed order.
export function codeHash(url) {
  const seen = new Set();
  const h = createHash('sha256');
  const visit = (u) => {
    const key = u.href;
    if (seen.has(key)) return;
    seen.add(key);
    const text = readFileSync(u, 'utf8');
    h.update(`${key}\n${text}\n`);
    const deps = [...text.matchAll(IMPORT)].map((m) => m[1] ?? m[2]).sort();
    for (const d of deps) visit(new URL(d, u));
  };
  visit(url);
  return h.digest('hex');
}

// A cache backed by `path` (or none, when `path` is null). `log` reports which
// stages were reused and which were computed.
export function stageCache(path, log = () => {}) {
  let saved = {};
  if (path) {
    try {
      const file = JSON.parse(readFileSync(path, 'utf8'));
      if (file && file.version === 2 && file.stages) saved = file.stages;
    } catch {
      // Missing, unreadable, or an older format: start empty.
    }
  }
  const stages = {};
  const reused = [];
  const computed = [];
  // Written atomically (temp file, then rename), so a run stopped mid-write
  // leaves the previous file intact.
  const write = (entries) => {
    if (!path) return;
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ version: 2, stages: entries }));
    renameSync(tmp, path);
  };
  return {
    run(name, key, fn) {
      const k = JSON.stringify(key);
      const hit = saved[name];
      let text;
      if (hit && hit.key === k) {
        text = hit.value;
        reused.push(name);
        log(`stats: ${name}: cached`);
        stages[name] = { key: k, value: text };
      } else {
        text = JSON.stringify(fn() ?? null);
        computed.push(name);
        stages[name] = { key: k, value: text };
        // Saved right away, so a run stopped later keeps this stage. Entries of
        // stages not reached yet are kept too; save() drops the unused ones.
        write({ ...saved, ...stages });
      }
      return JSON.parse(text);
    },
    save() {
      log(`stats: reused ${reused.length ? reused.join(', ') : 'nothing'}; computed ${computed.length ? computed.join(', ') : 'nothing'}`);
      write(stages);
    },
    get reused() { return [...reused]; },
    get computed() { return [...computed]; },
  };
}
