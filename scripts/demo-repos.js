// Builds the demonstration repositories behind the sample report: six fictional
// repositories with about forty fictional contributors (@example.com) over five
// and a half years. Everything is driven by a seeded random generator and fixed
// dates, so the repositories, their commit hashes, and the sample report built
// from them are identical on every run.
//
// The history is shaped to exercise every part of the report: a founder whose
// initial import seeds shared lines, services copied from the platform repo,
// boilerplate headers, a formatter commit, a dependency bot, contributors who
// leave, rewrites and deletions, reverts, and merges with conflicts resolved by
// hand.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SEED = 20260101;

function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (list) => list[Math.floor(next() * list.length)],
    chance: (p) => next() < p,
  };
}

const DAY = 86400;
const at = (y, m, d) => Date.UTC(y, m - 1, d, 10) / 1000;

const FIRST = ['Ada', 'Bruno', 'Cleo', 'Dmitri', 'Elif', 'Farid', 'Greta', 'Hugo', 'Ines', 'Jonas', 'Kaia', 'Lars', 'Mira',
  'Nils', 'Olga', 'Pavel', 'Quinn', 'Rosa', 'Sven', 'Tove', 'Umar', 'Vera', 'Wim', 'Xenia', 'Yusuf', 'Zora', 'Aron', 'Beatrix',
  'Casper', 'Dagny', 'Emil', 'Freja', 'Gustav', 'Hedda', 'Ivar', 'Juno', 'Kasimir', 'Linnea'];
const LAST = ['Lindqvist', 'Moreau', 'Okafor', 'Petrov', 'Quist', 'Rasmussen', 'Silva', 'Tanaka', 'Ulrich', 'Varga', 'Weber',
  'Yilmaz', 'Zeller', 'Andersen', 'Bianchi', 'Costa', 'Dahl', 'Eriksen', 'Fischer', 'Garcia'];

function people(r) {
  return FIRST.map((first, i) => {
    const last = LAST[(i * 7) % LAST.length];
    return { name: `${first} ${last}`, email: `${first.toLowerCase()}.${last.toLowerCase()}@example.com` };
  }).map((p) => ({ ...p, joins: at(2021, 1, 1) + r.int(0, 1700) * DAY }))
    .map((p) => ({ ...p, leaves: r.chance(0.35) ? p.joins + r.int(300, 1100) * DAY : Infinity }));
}

const BOT = { name: 'depbot[bot]', email: 'depbot@example.com', joins: 0, leaves: Infinity };
const FORMATTER = { name: 'Fiona Format', email: 'fiona.format@example.com', joins: 0, leaves: Infinity };
const FOUNDER = { name: 'Ada Lindqvist', email: 'ada.lindqvist@example.com', joins: 0, leaves: Infinity };

// --- content -------------------------------------------------------------------

const VERBS = ['get', 'set', 'load', 'save', 'build', 'parse', 'render', 'validate', 'compute', 'fetch', 'update', 'create', 'remove', 'resolve', 'format'];
const NOUNS = ['User', 'Order', 'Invoice', 'Session', 'Config', 'Report', 'Account', 'Payment', 'Token', 'Event', 'Queue', 'Cache', 'Record', 'Batch', 'Schema'];
const VARS = ['result', 'value', 'items', 'data', 'config', 'response', 'entry', 'total', 'count', 'index', 'key', 'options'];
const METHODS = ['map', 'filter', 'find', 'get', 'set', 'push', 'join', 'trim', 'slice', 'reduce'];
const HEADER_JS = ['/*', ' * Copyright Example Corp. All rights reserved.', ' * Licensed under the Example Corp internal license.', ' */', ''];
const HEADER_PY = ['# Copyright Example Corp. All rights reserved.', '# Licensed under the Example Corp internal license.', ''];

function jsFunction(r, indent = '  ') {
  const v = r.pick(VARS);
  const lines = [`export function ${r.pick(VERBS)}${r.pick(NOUNS)}(${r.pick(VARS)}, ${r.pick(VARS)}) {`];
  for (let i = r.int(2, 6); i > 0; i--) {
    const kind = r.int(0, 4);
    if (kind === 0) lines.push(`${indent}const ${r.pick(VARS)} = ${r.pick(VARS)}.${r.pick(METHODS)}(${r.pick(VARS)});`);
    else if (kind === 1) lines.push(`${indent}if (!${v}) {`, `${indent}${indent}return null;`, `${indent}}`);
    else if (kind === 2) lines.push(`${indent}${r.pick(VARS)}.${r.pick(METHODS)}(${r.pick(VARS)}, ${r.int(0, 9)});`);
    else if (kind === 3) lines.push('');
    else lines.push(`${indent}for (const ${r.pick(VARS)} of ${r.pick(VARS)}) {`, `${indent}${indent}${r.pick(VARS)} += ${r.int(1, 3)};`, `${indent}}`);
  }
  lines.push(`${indent}return ${v};`, '}', '');
  return lines;
}

function pyFunction(r) {
  const snake = `${r.pick(VERBS)}_${r.pick(NOUNS).toLowerCase()}`;
  const v = r.pick(VARS);
  const lines = [`def ${snake}(${r.pick(VARS)}, ${r.pick(VARS)}):`, `    """${r.pick(VERBS)[0].toUpperCase()}${r.pick(VERBS).slice(1)} the ${r.pick(NOUNS).toLowerCase()}."""`];
  for (let i = r.int(2, 5); i > 0; i--) {
    const kind = r.int(0, 3);
    if (kind === 0) lines.push(`    ${r.pick(VARS)} = ${r.pick(VARS)}.${r.pick(METHODS)}(${r.pick(VARS)})`);
    else if (kind === 1) lines.push(`    if not ${v}:`, '        return None');
    else if (kind === 2) lines.push('');
    else lines.push(`    for ${r.pick(VARS)} in ${r.pick(VARS)}:`, `        ${r.pick(VARS)} += ${r.int(1, 3)}`);
  }
  lines.push(`    return ${v}`, '', '');
  return lines;
}

function yamlBlock(r, service) {
  return [`- name: ${service}-${r.pick(NOUNS).toLowerCase()}`, `  image: registry.example.com/${service}:${r.int(1, 4)}.${r.int(0, 20)}.${r.int(0, 9)}`,
    `  replicas: ${r.int(1, 6)}`, '  env:', `    - name: ${r.pick(VARS).toUpperCase()}_${r.pick(NOUNS).toUpperCase()}`, `      value: "${r.pick(VARS)}"`, ''];
}

const DEPS = ['left-pad', 'lodash', 'express', 'zod', 'pino', 'undici', 'dayjs', 'uuid', 'yaml', 'chalk'];

function newFile(r, lang, service) {
  if (lang === 'js') {
    const lines = [...HEADER_JS, "'use strict';", '', `import { ${r.pick(NOUNS)} } from './${r.pick(NOUNS).toLowerCase()}.js';`, ''];
    for (let i = r.int(2, 6); i > 0; i--) lines.push(...jsFunction(r));
    return { path: `src/${r.pick(NOUNS).toLowerCase()}-${r.pick(VERBS)}.js`, lines };
  }
  if (lang === 'py') {
    const lines = [...HEADER_PY, 'import logging', '', 'log = logging.getLogger(__name__)', '', ''];
    for (let i = r.int(2, 6); i > 0; i--) lines.push(...pyFunction(r));
    return { path: `${service.replace(/-/g, '_')}/${r.pick(NOUNS).toLowerCase()}_${r.pick(VERBS)}.py`, lines };
  }
  const lines = [`# ${service} deployment`, ''];
  for (let i = r.int(2, 5); i > 0; i--) lines.push(...yamlBlock(r, service));
  return { path: `deploy/${r.pick(NOUNS).toLowerCase()}.yaml`, lines };
}

function newLines(r, lang, service) {
  if (lang === 'js') return jsFunction(r);
  if (lang === 'py') return pyFunction(r);
  return yamlBlock(r, service);
}

// --- git -----------------------------------------------------------------------

class Repo {
  constructor(root, name, lang) {
    this.dir = join(root, name);
    this.name = name;
    this.lang = lang;
    this.files = new Map(); // path -> lines
    this.history = new Map(); // path -> earlier versions (for reverts)
    this.dirty = new Set();
    mkdirSync(this.dir, { recursive: true });
    this.git(null, 0, 'init', '-q', '-b', 'main');
  }

  git(who, time, ...args) {
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' };
    if (who) {
      const date = `${time} +0000`;
      Object.assign(env, {
        GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email, GIT_COMMITTER_DATE: date,
      });
    }
    return execFileSync('git', ['-C', this.dir, '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', 'merge.ff=false', ...args],
      { env, stdio: ['ignore', 'pipe', 'pipe'] });
  }

  set(path, lines) {
    if (this.files.has(path)) {
      const versions = this.history.get(path) ?? [];
      versions.push(this.files.get(path));
      this.history.set(path, versions.slice(-5));
    }
    this.files.set(path, lines);
    this.dirty.add(path);
  }

  remove(path) {
    this.files.delete(path);
    this.dirty.add(path);
  }

  flush() {
    for (const path of this.dirty) {
      const full = join(this.dir, path);
      if (this.files.has(path)) {
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, `${this.files.get(path).join('\n')}\n`);
      } else {
        rmSync(full, { force: true });
      }
    }
    this.dirty.clear();
  }

  commit(who, time, message) {
    this.flush();
    this.git(who, time, 'add', '-A');
    this.git(who, time, 'commit', '-q', '--allow-empty', '-m', message);
  }
}

// --- history -------------------------------------------------------------------

const REPOS = [
  { name: 'platform', lang: 'js', start: at(2021, 1, 4), commits: 380 },
  { name: 'api-gateway', lang: 'js', start: at(2021, 9, 6), commits: 260, copyFrom: 'platform' },
  { name: 'billing-service', lang: 'js', start: at(2022, 4, 4), commits: 220, copyFrom: 'platform' },
  { name: 'web-frontend', lang: 'js', start: at(2021, 6, 7), commits: 300 },
  { name: 'data-pipeline', lang: 'py', start: at(2022, 1, 10), commits: 220 },
  { name: 'infra-config', lang: 'yaml', start: at(2021, 3, 1), commits: 160 },
];
const END = at(2026, 6, 26);

export function buildDemoRepos(root) {
  const r = rng(SEED);
  const team = people(r);
  const repos = new Map();

  for (const spec of REPOS) {
    const repo = new Repo(root, spec.name, spec.lang);
    repos.set(spec.name, repo);
    const step = (END - spec.start) / spec.commits;
    let time = spec.start;
    // Each repo has a core team; anyone may contribute occasionally.
    const core = team.filter(() => r.chance(0.3));

    // Initial import: a large first commit, by the founder in the platform repo.
    const first = spec.name === 'platform' ? FOUNDER : r.pick(core.length ? core : team);
    for (let i = 0; i < (spec.name === 'platform' ? 14 : 5); i++) {
      const f = newFile(r, spec.lang, spec.name);
      repo.set(f.path, f.lines);
    }
    if (spec.copyFrom) {
      // A service started by copying the platform's code.
      for (const [path, lines] of [...repos.get(spec.copyFrom).files].slice(0, 6)) repo.set(path, [...lines]);
    }
    if (spec.lang === 'js') repo.set('package.json', ['{', `  "name": "${spec.name}",`, '  "dependencies": {', ...DEPS.map((d) => `    "${d}": "^1.0.0",`), '    "noop": "^0.0.1"', '  }', '}']);
    repo.commit(first, time, 'Initial import');

    let merges = 0;
    for (let n = 1; n < spec.commits; n++) {
      time = Math.round(spec.start + n * step + r.int(0, Math.floor(step * 0.6)));
      const active = (p) => p.joins <= time && time < p.leaves;
      const pool = r.chance(0.8) ? core.filter(active) : team.filter(active);
      const who = pool.length ? r.pick(pool) : FOUNDER;
      const paths = [...repo.files.keys()].filter((p) => p !== 'package.json');
      const op = r.next();

      if (spec.lang === 'js' && op < 0.12) {
        // Dependency bump by the bot: many commits, few lines.
        const lines = repo.files.get('package.json').map((l) => (l.includes(`"${r.pick(DEPS)}"`) ? l.replace(/\^[\d.]+/, `^${r.int(1, 5)}.${r.int(0, 30)}.${r.int(0, 9)}`) : l));
        repo.set('package.json', lines);
        repo.commit(BOT, time, 'Bump dependencies');
      } else if (op < 0.32 || paths.length < 3) {
        const f = newFile(r, spec.lang, spec.name);
        repo.set(f.path, f.lines);
        repo.commit(who, time, `Add ${f.path}`);
      } else if (op < 0.82) {
        // Rewrite: replace a range of lines, often with more than before.
        const path = r.pick(paths);
        const lines = [...repo.files.get(path)];
        const from = r.int(0, Math.max(0, lines.length - 1));
        lines.splice(from, r.int(1, 10), ...newLines(r, spec.lang, spec.name));
        repo.set(path, lines);
        repo.commit(who, time, `Update ${path}`);
      } else if (op < 0.86 && paths.length > 6) {
        const path = r.pick(paths);
        repo.remove(path);
        repo.commit(who, time, `Remove ${path}`);
      } else if (op < 0.9) {
        // Revert a file to an earlier version: its lines go back to their first authors.
        const path = r.pick(paths);
        const versions = repo.history.get(path);
        if (versions?.length) {
          repo.set(path, [...versions[r.int(0, versions.length - 1)]]);
          repo.commit(who, time, `Revert ${path}`);
        } else {
          repo.commit(who, time, 'Empty');
        }
      } else if (op < 0.93) {
        // Copy a file from another repository.
        const other = r.pick([...repos.values()].filter((x) => x !== repo && x.lang === spec.lang && x.files.size));
        if (other) {
          const [path, lines] = r.pick([...other.files].filter(([p]) => p !== 'package.json'));
          repo.set(path, [...lines]);
          repo.commit(who, time, `Copy ${path} from ${other.name}`);
        } else {
          repo.commit(who, time, 'Empty');
        }
      } else if (merges < 3 && n > spec.commits / 4) {
        mergeWithConflict(repo, r, team.filter(active), time, merges++);
      } else {
        const path = r.pick(paths);
        const lines = [...repo.files.get(path)];
        lines.push(...newLines(r, spec.lang, spec.name));
        repo.set(path, lines);
        repo.commit(who, time, `Extend ${path}`);
      }

      // One formatter commit per JavaScript repo, halfway through: every
      // two-space indent becomes four.
      if (spec.lang === 'js' && n === Math.floor(spec.commits / 2)) {
        for (const path of repo.files.keys()) {
          if (path.endsWith('.js')) repo.set(path, repo.files.get(path).map((l) => l.replace(/^( {2})+/, (m) => ' '.repeat(m.length * 2))));
        }
        repo.commit(FORMATTER, time + 3600, 'Apply formatter');
      }
    }
  }

  // Declared ownership: every repo gets a CODEOWNERS file late in its history,
  // committed after all repos are built and without the random generator, so
  // the seeded history above is unchanged. The rules are what such files tend
  // to become: a catch-all, a later rule that overrides an earlier one, a team
  // for a directory that no longer exists, and a rule that owns nothing.
  for (const spec of REPOS) {
    const repo = repos.get(spec.name);
    repo.set('CODEOWNERS', codeowners(spec));
    repo.commit(GOVERNANCE, CODEOWNERS_TIME, 'Add CODEOWNERS');
  }
  return [...repos.values()].map((repo) => repo.dir);
}

const GOVERNANCE = { name: 'Petra Process', email: 'petra.process@example.com' };
const CODEOWNERS_TIME = at(2026, 6, 1);

function codeowners(spec) {
  const team = `@acme/${spec.name}-team`;
  const lines = ['# Ownership is reviewed quarterly.', `*                 @acme/architecture`];
  if (spec.lang === 'js') {
    lines.push(`/src/             ${team}`, '*.js              @acme/javascript-guild', '/package.json     @acme/dependency-council');
  } else if (spec.lang === 'py') {
    lines.push(`/${spec.name.replace(/-/g, '_')}/  ${team}`, '*.py              @acme/python-guild');
  } else {
    lines.push(`/deploy/          ${team} @acme/sre`);
  }
  lines.push(`/legacy/          @acme/${spec.name}-legacy-team`, '/docs/');
  return lines;
}

// Two people change the same line on main and on a branch; a third merges and
// writes a resolution of their own.
function mergeWithConflict(repo, r, pool, time, n) {
  const [a, b, merger] = [r.pick(pool.length ? pool : [FOUNDER]), r.pick(pool.length ? pool : [FOUNDER]), r.pick(pool.length ? pool : [FOUNDER])];
  const path = r.pick([...repo.files.keys()].filter((p) => p !== 'package.json' && repo.files.get(p).length > 4));
  if (!path) return repo.commit(merger, time, 'Empty');
  const base = repo.files.get(path);
  const line = r.int(1, base.length - 2);
  const branch = `topic-${n}`;
  repo.git(a, time, 'checkout', '-q', '-b', branch);
  repo.set(path, base.map((l, i) => (i === line ? `${l} // ${r.pick(VARS)} from the branch` : l)));
  repo.commit(a, time, `Change ${path} on ${branch}`);
  repo.git(b, time + 60, 'checkout', '-q', 'main');
  repo.files.set(path, base);
  repo.set(path, base.map((l, i) => (i === line ? `${l} // ${r.pick(VARS)} on main` : l)));
  repo.commit(b, time + 60, `Change ${path} on main`);
  try {
    repo.git(merger, time + 120, 'merge', '-q', '--no-ff', branch);
  } catch {
    // Conflict expected.
  }
  repo.set(path, base.map((l, i) => (i === line ? `${l} // resolved by ${merger.name.split(' ')[0].toLowerCase()}` : l)));
  repo.flush();
  repo.git(merger, time + 120, 'add', '-A');
  repo.git(merger, time + 120, 'commit', '-q', '-m', `Merge ${branch}`);
  repo.git(merger, time + 120, 'branch', '-q', '-D', branch);
}
