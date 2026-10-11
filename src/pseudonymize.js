// `report --pseudonymize`: replaces every committer name and email in the
// stats with "Contributor N" before anything is rendered, so all report files
// (Markdown, HTML, JSON, CSV, SVG, AI prose) show the same pseudonyms.
//
// - Identity objects ({ name, email }) are replaced wherever they appear,
//   keyed by email. N follows rank by lines owned, then the order the rest
//   appear in the stats, so the same database gives the same numbering.
// - Committers that are automation (`isBot`) keep their names: they are not
//   people, and the bot oddities and the automation archetype need them.
// - Other strings (line text, paths, CODEOWNERS patterns) are searched for
//   known emails and names of more than one word, which are replaced too.
//   One-word names are left, since they are ordinary words as often as names,
//   and so are names of people who never committed (a copyright holder).
// - CODEOWNERS handles become "@user-N", "@team-N", or "user-N@example.invalid".
import { isBot } from './oddities.js';

const isIdentity = (x) => x && typeof x === 'object' && !Array.isArray(x)
  && Object.keys(x).length === 2 && typeof x.name === 'string' && typeof x.email === 'string';

export function pseudonymizeStats(stats) {
  const byEmail = new Map(); // email -> { name, email } pseudonym
  const realNames = new Map(); // email -> real name
  const assign = (o) => {
    if (isBot(o)) return o;
    let p = byEmail.get(o.email);
    if (!p) {
      const n = byEmail.size + 1;
      p = { name: `Contributor ${n}`, email: `contributor-${n}@example.invalid` };
      byEmail.set(o.email, p);
      realNames.set(o.email, o.name);
    }
    return p;
  };
  for (const o of stats.owners) if (o.owner) assign(o.owner);
  const collect = (x) => {
    if (Array.isArray(x)) x.forEach(collect);
    else if (isIdentity(x)) assign(x);
    else if (x && typeof x === 'object') Object.values(x).forEach(collect);
  };
  collect(stats);

  // Names and emails inside other text, longest first so a full name wins
  // over a shorter one it contains.
  const words = [];
  for (const [email, p] of byEmail) {
    words.push([email, p.email]);
    const name = realNames.get(email);
    if (/\s/.test(name.trim())) words.push([name, p.name]);
  }
  words.sort((a, b) => b[0].length - a[0].length);
  const replacement = new Map(words);
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = words.length ? new RegExp(words.map(([w]) => `(?<![\\w@.-])${escape(w)}(?![\\w@-])`).join('|'), 'g') : null;
  const scrub = (s) => (pattern ? s.replace(pattern, (m) => replacement.get(m) ?? m) : s);

  const handles = new Map();
  const counters = { user: 0, team: 0, email: 0 };
  const handle = (h) => {
    if (!handles.has(h)) {
      const kind = h.includes('@') && !h.startsWith('@') ? 'email' : h.includes('/') ? 'team' : 'user';
      const n = ++counters[kind];
      handles.set(h, kind === 'email' ? `user-${n}@example.invalid` : `@${kind}-${n}`);
    }
    return handles.get(h);
  };

  const walk = (x, key) => {
    if (typeof x === 'string') return scrub(x);
    if (Array.isArray(x)) return key === 'owners' && x.every((h) => typeof h === 'string') ? x.map(handle) : x.map((v) => walk(v));
    if (isIdentity(x)) return assign(x);
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, walk(v, k)]));
    return x;
  };
  return walk(stats);
}
