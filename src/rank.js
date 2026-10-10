// Ranking helpers shared by stats.js and the cached stages that rank owners
// themselves (codeowners.js), so a stage's code hash covers them.

export function share(n, total) {
  return total === 0 ? 0 : n / total;
}

// Most lines first; ties by email, unattributed last. `counts` is a Map of
// identity id (or null) -> lines.
export function rankOwners(counts, identities) {
  return [...counts]
    .map(([identityId, lines]) => ({ identityId, owner: identities.get(identityId) ?? null, lines }))
    .sort((a, b) => b.lines - a.lines || compareNullLast(a.owner?.email ?? null, b.owner?.email ?? null));
}

// The top attributed owner: { owner, identityId, count, total, share }, or null
// if none. `total` defaults to the sum of counts.
export function topOf(counts, identities, total) {
  if (total === undefined) {
    total = 0;
    for (const n of counts.values()) total += n;
  }
  const ranked = rankOwners(counts, identities).filter((o) => o.owner);
  if (ranked.length === 0) return null;
  const t = ranked[0];
  return { owner: t.owner, identityId: t.identityId, count: Math.round(t.lines), total: Math.round(total), share: share(t.lines, total) };
}

export function compareNullLast(a, b) {
  if (a === null || b === null) return a === null ? (b === null ? 0 : 1) : -1;
  return a < b ? -1 : a > b ? 1 : 0;
}
