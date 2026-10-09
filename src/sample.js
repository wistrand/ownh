import { createHash } from 'node:crypto';

// The blame sample of a repo: the `n` paths with the smallest SHA-256 of their
// path. Deterministic, so `ownh blame` and the report agree on which files are in
// the sample and an interrupted run resumes the same sample, and effectively
// random with respect to directory layout and history.
export function samplePaths(paths, n) {
  if (paths.length <= n) return [...paths];
  return paths
    .map((p) => [createHash('sha256').update(p).digest('hex'), p])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, n)
    .map(([, p]) => p);
}
