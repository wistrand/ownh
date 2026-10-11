// `report --pseudonymize`: replaces every committer name and email in the
// stats with "Contributor N" before anything is rendered, so all report files
// (Markdown, HTML, JSON, CSV, SVG, AI prose) show the same pseudonyms.
//
// - Identity objects ({ name, email }) are replaced wherever they appear,
//   keyed by email. N follows rank by lines owned, then the order the rest
//   appear in the stats, so the same database gives the same numbering.
// - Committers that are automation (`isBot`) keep their name, since the bot
//   oddities and the automation archetype need it, but their email is
//   replaced unless it is itself an automation address: a bot-like name can
//   sit on a person's email, and "Bot" is also a surname.
// - Other strings (line text, paths, CODEOWNERS patterns) are searched, in any
//   case, for known emails, for every name of more than one word an identity
//   committed under (`aliases`, from the commits), and for CODEOWNERS handles.
//   One-word names are left, since they are ordinary words as often as names,
//   and so are names of people who never committed (a copyright holder).
// - CODEOWNERS handles become "@user-N", "@team-N", or "user-N@example.invalid".
// - Repository names and the database name are not replaced.
import { isBot, isBotEmail } from './oddities.js';

const isIdentity = (x) => x && typeof x === 'object' && !Array.isArray(x)
  && Object.keys(x).length === 2 && typeof x.name === 'string' && typeof x.email === 'string';

// Names per regex: V8 refuses a regex with tens of thousands of alternatives.
const CHUNK = 2000;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// `aliases`: Map(email -> names committed under), optional.
export function pseudonymizeStats(stats, { aliases = new Map() } = {}) {
  const byEmail = new Map(); // email -> { name, email } pseudonym
  let people = 0;
  let bots = 0;
  const assign = (o) => {
    let p = byEmail.get(o.email);
    if (!p) {
      if (isBot(o)) {
        p = isBotEmail(o.email) ? o : { name: o.name, email: `automation-${++bots}@example.invalid` };
      } else {
        const n = ++people;
        p = { name: `Contributor ${n}`, email: `contributor-${n}@example.invalid` };
      }
      byEmail.set(o.email, p);
    }
    return p;
  };
  const realNames = new Map(); // email -> Set of names
  const addName = (email, name) => {
    if (!realNames.has(email)) realNames.set(email, new Set());
    realNames.get(email).add(name);
  };
  for (const o of stats.owners) if (o.owner) assign(o.owner);
  // Identities, and CODEOWNERS handles (string arrays under `owners`).
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
  const isHandles = (key, x) => key === 'owners' && Array.isArray(x) && x.every((h) => typeof h === 'string');
  const collect = (x, key) => {
    if (isHandles(key, x)) x.forEach(handle);
    else if (Array.isArray(x)) x.forEach((v) => collect(v));
    else if (isIdentity(x)) {
      assign(x);
      addName(x.email, x.name);
    } else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) collect(v, k);
  };
  collect(stats);
  for (const [email, names] of aliases) if (byEmail.has(email)) for (const n of names) addName(email, n);

  // Text to find inside other strings, matched in any case and looked up
  // lowercased. Longest first, so a full name wins over a shorter one inside it.
  const replacement = new Map();
  for (const [email, p] of byEmail) {
    if (p.email !== email) replacement.set(email.toLowerCase(), p.email);
    if (p.name.startsWith('Contributor ')) {
      for (const n of realNames.get(email) ?? []) if (/\s/.test(n.trim())) replacement.set(n.trim().toLowerCase(), p.name);
    }
  }
  for (const [h, to] of handles) if (h.length >= 3) replacement.set(h.toLowerCase(), to);
  const words = [...replacement.keys()].sort((a, b) => b.length - a.length);
  const patterns = [];
  for (let i = 0; i < words.length; i += CHUNK) {
    patterns.push(new RegExp(words.slice(i, i + CHUNK).map((w) => `(?<![\\w@.-])${escape(w)}(?![\\w@-])`).join('|'), 'gi'));
  }
  const scrub = (s) => patterns.reduce((t, re) => t.replace(re, (m) => replacement.get(m.toLowerCase()) ?? m), s);

  const walk = (x, key) => {
    if (typeof x === 'string') return scrub(x);
    if (isHandles(key, x)) return x.map(handle);
    if (Array.isArray(x)) return x.map((v) => walk(v));
    if (isIdentity(x)) return assign(x);
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, walk(v, k)]));
    return x;
  };
  return walk(stats);
}
