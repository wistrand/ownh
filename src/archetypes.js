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
  const removedOthers = new Map((stats.deletions?.topRemovers ?? []).filter((r) => r.owner).map((r) => [r.owner.email, r.lines]));

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
      members: owners.filter((o) => (removedOthers.get(o.owner.email) ?? 0) > o.lines),
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
