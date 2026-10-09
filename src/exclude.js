import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Used by the CLI when no --exclude-file is given. It is optional (and git-ignored,
// since it tends to hold project-specific paths): without it, nothing is excluded.
export const DEFAULT_EXCLUDE_FILE = fileURLToPath(new URL('../ownh.exclude', import.meta.url));

// Patterns from the default exclude file, or null when it doesn't exist.
export function readDefaultExcludes() {
  return existsSync(DEFAULT_EXCLUDE_FILE) ? readExcludeFile(DEFAULT_EXCLUDE_FILE) : null;
}

// One pattern per line; blank lines and lines starting with "#" are ignored.
export function readExcludeFile(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

// Turns exclude patterns into git exclude pathspecs, so git applies them
// identically to history (log) and HEAD (diff against the empty tree).
// Semantics follow .gitignore loosely:
//   "dist/"         a directory named dist at any depth
//   "*.png"         no slash: matches a file or directory name at any depth
//   "conf/a.json"   contains a slash: anchored at the repo root
//   "/build"        leading slash: anchored at the repo root
// A pattern that matches a directory also excludes everything under it.
export function toPathspecs(patterns) {
  return patterns.flatMap((pattern) => {
    const dirOnly = pattern.endsWith('/');
    let p = pattern.replace(/\/+$/, '');
    const anchored = p.includes('/');
    p = p.replace(/^\/+/, '');
    const base = anchored ? p : `**/${p}`;
    const globs = dirOnly ? [`${base}/**`] : [base, `${base}/**`];
    return globs.map((g) => `:(exclude,glob)${g}`);
  });
}
