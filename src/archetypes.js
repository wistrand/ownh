// Owner archetypes: groups of owners defined by fixed rules over the stats.
// Membership is computed here, deterministically; the optional AI step only
// gives each group a name (see ai.js). Groups with no members are left out.
import { isBot } from './oddities.js';
import { quarterOf } from './timeline.js';

// No commit in this many quarters (including the current one) means inactive.
const ACTIVE_WINDOW = 4;

// Plain names, used when no AI names are available.
export const ARCHETYPE_TITLES = {
  principal: 'Principal owner',
  inactive: 'Inactive owners',
  absentee: 'Absentee owners',
  leverage: 'High-leverage owners',
  demolition: 'Net demolishers',
  automation: 'Automation',
};

// Example owners as display names. Identities are emails, so two can share a
// name (an author with an old and a new address); those get their email too,
// so the list does not read as a duplicate.
export function exampleLabels(owners) {
  const count = new Map();
  for (const o of owners) count.set(o.name, (count.get(o.name) ?? 0) + 1);
  return owners.map((o) => (count.get(o.name) > 1 ? `${o.name} <${o.email}>` : o.name));
}

export function findArchetypes(stats) {
  const owners = stats.owners.filter((o) => o.owner);
  if (owners.length === 0) return [];
  const now = stats.timeline?.now ?? null;
  const total = stats.total;
  const minOwned = Math.min(100, Math.ceil(total * 0.01));

  // Lines each owner holds in repositories they never committed to.
  const absentee = new Map();
  for (const r of stats.repos) {
    for (const o of r.owners) if (o.owner && !o.contributor) absentee.set(o.identityId, (absentee.get(o.identityId) ?? 0) + o.lines);
  }

  const groups = [
    {
      key: 'principal',
      rule: 'The single owner with the most lines.',
      members: owners.slice(0, 1),
    },
    {
      key: 'inactive',
      rule: `Owners with no commit in the last ${ACTIVE_WINDOW} quarters.`,
      members: now === null ? [] : owners.filter((o) => o.lastCommit !== null && quarterOf(o.lastCommit) <= now - ACTIVE_WINDOW),
    },
    {
      key: 'absentee',
      rule: 'Owners with most of their lines in repositories they never committed to.',
      members: owners.filter((o) => (absentee.get(o.identityId) ?? 0) > o.lines / 2),
    },
    {
      key: 'leverage',
      rule: `Owners with at least ${minOwned} lines who own 10 or more lines per line written.`,
      // For the AI: minOwned depends on the line total for small databases, so
      // the threshold is described, not stated.
      aiRule: 'Owners who own 10 or more lines per line written, excluding owners with very few lines.',
      members: owners.filter((o) => o.written > 0 && o.lines >= minOwned && o.lines / o.written >= 10),
    },
    {
      key: 'demolition',
      rule: 'People who removed more lines belonging to others than they own.',
      // Every owner's own count (stats.js), not the top-10 removers list.
      members: owners.filter((o) => (o.removedOthers ?? 0) > o.lines),
    },
    {
      key: 'automation',
      rule: 'Automated accounts (bots) that own lines.',
      members: owners.filter((o) => isBot(o.owner)),
    },
  ];

  return groups.filter((g) => g.members.length > 0).map((g) => {
    const lines = g.members.reduce((s, o) => s + o.lines, 0);
    return {
      key: g.key,
      rule: g.rule,
      // The rule as sent to the AI: never a number derived from the data.
      aiRule: g.aiRule ?? g.rule,
      members: g.members.length,
      lines,
      share: total ? lines / total : 0,
      examples: g.members.slice(0, 3).map((o) => o.owner),
    };
  });
}
