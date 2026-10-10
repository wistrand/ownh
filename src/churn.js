// Analyses built on the churn table (lines added and removed per hash, repo,
// quarter, and author): ownership history, deletions, and code survival.
// Owners are resolved through line_hashes, so "owner" means the same thing here
// as everywhere else in the report.

const OWNER_OF_HASH = `
JOIN line_hashes l ON l.hash = ch.hash
JOIN commits c ON c.id = l.commit_id
`;

export function hasChurn(db) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'churn'").get());
}

// Net lines (added minus removed) by (repo, owner, quarter): the input for a
// true ownership history, in the same shape as the surviving-line cohorts.
export function netByQuarter(db) {
  return db.prepare(`
    SELECT ch.repo_id AS repoId, c.identity_id AS identityId, ch.q AS q, SUM(ch.added - ch.removed) AS n
    FROM churn ch ${OWNER_OF_HASH}
    GROUP BY ch.repo_id, c.identity_id, ch.q
  `).all();
}

// Who removes whose lines, the most-removed line, and lines that came back.
export function deletions(db, identities) {
  const pairs = db.prepare(`
    SELECT ch.identity_id AS remover, c.identity_id AS owner, SUM(ch.removed) AS n
    FROM churn ch ${OWNER_OF_HASH}
    WHERE ch.removed > 0
    GROUP BY ch.identity_id, c.identity_id
  `).all();
  const removedOthers = new Map(); // remover -> lines of other people's removed
  const removedOwn = new Map(); // remover -> own lines removed
  const lostToOthers = new Map(); // owner -> lines removed by someone else
  let total = 0;
  let others = 0;
  for (const { remover, owner, n } of pairs) {
    total += n;
    if (remover === owner) {
      removedOwn.set(remover, (removedOwn.get(remover) ?? 0) + n);
    } else {
      others += n;
      removedOthers.set(remover, (removedOthers.get(remover) ?? 0) + n);
      lostToOthers.set(owner, (lostToOthers.get(owner) ?? 0) + n);
    }
  }
  // Ties go to the smaller email, never the identity id: ids follow insertion
  // order, which `add` does not keep, and the result must not depend on it.
  const email = (id) => identities.get(id)?.email ?? '';
  const rank = (m) => [...m]
    .sort((a, b) => b[1] - a[1] || (email(a[0]) < email(b[0]) ? -1 : email(a[0]) > email(b[0]) ? 1 : 0))
    .slice(0, 10)
    .map(([id, n]) => ({ owner: identities.get(id) ?? null, lines: n, ownRemoved: removedOwn.get(id) ?? 0 }));

  const mostRemoved = db.prepare(`
    SELECT ch.hash, SUM(ch.removed) AS n, l.text, l.binary, l.path, c.identity_id AS owner
    FROM churn ch ${OWNER_OF_HASH}
    GROUP BY ch.hash ORDER BY n DESC, ch.hash LIMIT 1
  `).get();

  // Lines added again after the first quarter in which that line was removed:
  // each went straight back to its original owner.
  const restored = db.prepare(`
    WITH first_removal AS (SELECT hash, MIN(q) AS q0 FROM churn WHERE removed > 0 GROUP BY hash)
    SELECT COUNT(DISTINCT ch.hash) AS hashes, COALESCE(SUM(ch.added), 0) AS lines
    FROM churn ch JOIN first_removal f ON f.hash = ch.hash AND ch.q > f.q0
    WHERE ch.added > 0
  `).get();

  const added = db.prepare('SELECT COALESCE(SUM(added), 0) AS n FROM churn').get().n;
  return {
    added,
    removed: total,
    removedOfOthers: others,
    topRemovers: rank(removedOthers),
    mostRemovedOwners: rank(lostToOthers),
    mostRemovedLine: mostRemoved && mostRemoved.n > 0 ? {
      text: mostRemoved.text,
      binary: Boolean(mostRemoved.binary),
      path: mostRemoved.path,
      lines: mostRemoved.n,
      owner: identities.get(mostRemoved.owner) ?? null,
    } : null,
    restored,
    // Every remover, not only the top 10: identity id -> lines of others
    // removed. A Map for collectStats only; it is not part of the stats output.
    removedOthersBy: removedOthers,
  };
}

// Survival of lines, per owner. Copies of the same line can't be told apart, so
// within each hash and repository removals are paired with the oldest surviving
// additions first (a removal in one repo never ends a copy in another). Each paired line "dies" at its age in quarters; lines still present are
// censored at their age now. Survival is the Kaplan-Meier estimate over those
// ages, and the half-life is the first age at which it drops to 50% or below,
// or, if it never does, an exponential extrapolation from the last point.
export function survival(db, groups, now) {
  // group key (identity id, or 'all') -> { deaths: Map(age -> n), censored: Map(age -> n) }
  const stats = new Map([...groups.map((g) => [g, { deaths: new Map(), censored: new Map() }]), ['all', { deaths: new Map(), censored: new Map() }]]);
  const bump = (m, k, n) => m.set(k, (m.get(k) ?? 0) + n);
  const record = (owner, kind, age, n) => {
    for (const key of ['all', owner]) {
      const s = stats.get(key);
      if (s) bump(s[kind], age, n);
    }
  };

  const rows = db.prepare(`
    SELECT ch.hash AS hash, ch.repo_id AS repoId, c.identity_id AS owner, ch.q AS q, SUM(ch.added) AS added, SUM(ch.removed) AS removed
    FROM churn ch ${OWNER_OF_HASH}
    GROUP BY ch.hash, ch.repo_id, ch.q
    ORDER BY ch.hash, ch.repo_id, ch.q
  `).iterate();

  let current = null;
  let owner = null;
  let queue = []; // [quarter added, count], oldest first
  // Ages are clamped at 0: "now" is the newest commit's quarter, so nothing
  // should be younger, but a negative age would never leave the at-risk set.
  const finish = () => {
    for (const [q, n] of queue) if (n > 0) record(owner, 'censored', Math.max(0, now - q), n);
  };
  for (const row of rows) {
    const key = `${row.hash}:${row.repoId}`;
    if (key !== current) {
      if (current !== null) finish();
      current = key;
      owner = row.owner;
      queue = [];
    }
    // Additions in a quarter come before that quarter's removals.
    if (row.added > 0) queue.push([row.q, row.added]);
    let toRemove = row.removed;
    while (toRemove > 0 && queue.length) {
      const head = queue[0];
      const take = Math.min(head[1], toRemove);
      record(owner, 'deaths', row.q - head[0], take);
      head[1] -= take;
      toRemove -= take;
      if (head[1] === 0) queue.shift();
    }
  }
  if (current !== null) finish();

  const out = new Map();
  for (const [key, s] of stats) out.set(key, kaplanMeier(s.deaths, s.censored));
  return out;
}

// Discrete Kaplan-Meier over ages in quarters: at each age, the share of lines
// still alive that die at that age. Returns { curve: [S(0), S(1), ...],
// halfLife, projected, lines }.
export function kaplanMeier(deaths, censored) {
  const maxAge = Math.max(0, ...deaths.keys(), ...censored.keys());
  let atRisk = 0;
  for (const n of deaths.values()) atRisk += n;
  for (const n of censored.values()) atRisk += n;
  const lines = atRisk;
  const curve = [];
  let s = 1;
  let halfLife = null;
  for (let age = 0; age <= maxAge; age++) {
    const d = deaths.get(age) ?? 0;
    if (atRisk > 0) s *= 1 - d / atRisk;
    curve.push(s);
    if (halfLife === null && s <= 0.5) halfLife = age;
    atRisk -= d + (censored.get(age) ?? 0);
  }
  let projected = false;
  if (halfLife === null && curve.length > 1 && s < 1 && s > 0) {
    // Exponential decay through the last point: S(t) = exp(-k t).
    const k = -Math.log(s) / (curve.length - 1);
    halfLife = Math.log(2) / k;
    projected = true;
  }
  return { curve, halfLife, projected, lines };
}
