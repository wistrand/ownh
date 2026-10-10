// Odd findings for the report's "Oddities" section. Every finding is a fact
// derived from collectStats output, never an estimate or a guess, so it can be
// regenerated and checked like any other number in the report.
//
// A finding is { kind, title, detail }, where detail is a list of segments:
// { text } for prose and { code } for literal lines or names, so each renderer
// can escape them its own way.
import { lineLabel, pct, share } from './stats.js';

// Names lists in findings are cut to this many, with "and N more".
const MAX_NAMES = 5;

// Lines with no letters or digits: blank lines, braces, brackets, punctuation.
const TRIVIAL_LINE = /^[\s{}()[\];,.:<>/\\*#'"`=+-]*$/;

// Committers that are automation, not people.
const BOT = /\[bot\]|dependabot|renovate|scala-steward|semantic[ -]release|github-actions/i;

export function findOddities(stats) {
  return [
    ...trivialLines(stats),
    ...crlfTwins(stats),
    ...binaryDuplicates(stats),
    ...outsourcedRepos(stats),
    ...absenteeTopOwners(stats),
    ...nonContributorMajority(stats),
    ...botCommitters(stats),
    ...threeWaySplits(stats),
    ...linesPerCommit(stats),
    ...leverageOddity(stats),
    ...demolition(stats),
    ...unattributed(stats),
  ];
}

function trivialLines(stats) {
  const found = [];
  const top = stats.lines[0];
  if (top && top.binary === false && TRIVIAL_LINE.test(top.text)) {
    found.push({
      kind: 'trivial-top-line',
      title: 'The most-owned line has no letters or digits',
      detail: [
        { code: lineLabel(top) },
        { text: ` appears ${num(top.lines)} times (${pct(top.lines, stats.total)} of all lines) and belongs to ${top.owner ? top.owner.name : 'no one'}, who wrote it first in ${top.origin}.` },
      ],
    });
  }
  const trivial = stats.lines.filter((l) => l.binary === false && TRIVIAL_LINE.test(l.text));
  if (trivial.length > 1) {
    const lines = trivial.reduce((s, l) => s + l.lines, 0);
    found.push({
      kind: 'trivial-lines',
      title: `${trivial.length} of the top ${stats.lines.length} lines are whitespace or punctuation`,
      detail: [{ text: `Together they hold ${pct(lines, stats.total)} of all lines: ` }, ...listCode(trivial.map((l) => lineLabel(l))), { text: '.' }],
    });
  }
  return found;
}

function crlfTwins(stats) {
  const texts = new Set(stats.lines.filter((l) => l.binary === false).map((l) => l.text));
  const twins = stats.lines.filter((l) => l.binary === false && l.text.endsWith('\r') && texts.has(l.text.slice(0, -1)));
  return twins.map((l) => {
    const lf = stats.lines.find((x) => x.binary === false && x.text === l.text.slice(0, -1));
    return {
      kind: 'crlf-twin',
      title: 'The same line, owned twice',
      detail: [
        { code: lineLabel(lf) }, { text: ` belongs to ${ownerName(lf)} and ` },
        { code: lineLabel(l) }, { text: ` (Windows line ending) to ${ownerName(l)}.` },
      ],
    };
  });
}

function binaryDuplicates(stats) {
  return stats.lines.filter((l) => l.binary === true && l.lines > 1).map((l) => ({
    kind: 'binary-duplicate',
    title: 'A binary file is one of the most-owned lines',
    detail: [
      { text: 'The file first committed as ' }, { code: l.path },
      { text: ` exists ${num(l.lines)} times with identical content. Each copy is one line, owned by ${ownerName(l)}.` },
    ],
  }));
}

// Repos where more lines were first written in one other repo than in the repo itself.
function outsourcedRepos(stats) {
  const hits = [];
  for (const r of stats.repos) {
    const own = r.origins.find((o) => o.repo === r.name)?.lines ?? 0;
    const outside = r.origins.find((o) => o.repo !== null && o.repo !== r.name);
    if (outside && outside.lines > own) hits.push({ r, own, outside });
  }
  hits.sort((a, b) => share(b.outside.lines, b.r.lines) - share(a.outside.lines, a.r.lines) || cmp(a.r.name, b.r.name));
  return hits.map(({ r, own, outside }) => ({
    kind: 'outsourced',
    title: `${r.name} was mostly written somewhere else`,
    detail: [{ text: `${pct(outside.lines, r.lines)} of its lines were first written in ${outside.repo}; ${pct(own, r.lines)} in ${r.name} itself.` }],
  }));
}

// Repos whose top owner by line hash has never committed to them.
function absenteeTopOwners(stats) {
  const hits = stats.repos
    .map((r) => ({ r, top: r.owners.find((o) => o.owner) }))
    .filter(({ top }) => top && !top.contributor);
  if (hits.length === 0) return [];
  return [{
    kind: 'absentee-owner',
    title: `${hits.length} of ${stats.repos.length} repositories ${hits.length === 1 ? 'is' : 'are'} owned by someone who never committed to ${hits.length === 1 ? 'it' : 'them'}`,
    detail: [{ text: names(hits.map(({ r, top }) => `${r.name} (${top.owner.name}, ${pct(top.lines, r.lines)})`)) + '.' }],
  }];
}

function nonContributorMajority(stats) {
  const hits = stats.repos.filter((r) => share(r.absentee, r.lines) > 0.5)
    .sort((a, b) => share(b.absentee, b.lines) - share(a.absentee, a.lines) || cmp(a.name, b.name));
  if (hits.length === 0) return [];
  return [{
    kind: 'non-contributor-majority',
    title: `In ${hits.length} ${hits.length === 1 ? 'repository' : 'repositories'}, most lines belong to people who never committed there`,
    detail: [{ text: names(hits.map((r) => `${r.name} (${pct(r.absentee, r.lines)})`)) + '.' }],
  }];
}

// Repos whose top committer is automation.
function botCommitters(stats) {
  const byBot = new Map();
  for (const r of stats.repos) {
    const top = r.methods?.commits;
    if (!top || !isBot(top.owner)) continue;
    const key = top.owner.email;
    if (!byBot.has(key)) byBot.set(key, { name: top.owner.name, repos: [], topElsewhere: false });
    const entry = byBot.get(key);
    entry.repos.push(`${r.name} (${pct(top.count, top.total)} of commits)`);
    // Whether blame or line hash also name it the top owner of this repo.
    if (r.methods.blame?.owner.email === key || r.methods.hash?.owner.email === key) entry.topElsewhere = true;
  }
  return [...byBot.values()].sort((a, b) => b.repos.length - a.repos.length || cmp(a.name, b.name)).map((b) => ({
    kind: 'bot-committer',
    title: `${b.name} is the top committer in ${b.repos.length} ${b.repos.length === 1 ? 'repository' : 'repositories'}`,
    detail: [{ text: `${names(b.repos)}.${b.topElsewhere ? '' : ` ${b.repos.length === 1 ? 'There' : 'In each of them'}, git blame and line hash both name someone else the top owner.`}` }],
  }));
}

// Repos where commit count, blame, and line hash name three different people.
function threeWaySplits(stats) {
  const hits = stats.repos.filter((r) => {
    const m = r.methods;
    if (!m?.commits || !m.blame || !m.hash) return false;
    const emails = new Set([m.commits.owner.email, m.blame.owner.email, m.hash.owner.email]);
    return emails.size === 3;
  });
  if (hits.length === 0) return [];
  return [{
    kind: 'three-way-split',
    title: `Three methods, three owners, in ${hits.length} ${hits.length === 1 ? 'repository' : 'repositories'}`,
    detail: [{ text: names(hits.map((r) => `${r.name} (${r.methods.commits.owner.name} / ${r.methods.blame.owner.name} / ${r.methods.hash.owner.name})`)) + '.' }],
  }];
}

// Among the top owners, the one holding the most lines per commit.
function linesPerCommit(stats) {
  const candidates = stats.owners.filter((o) => o.owner && o.commits > 0).slice(0, 20);
  if (candidates.length === 0) return [];
  const best = candidates.reduce((a, b) => (b.lines / b.commits > a.lines / a.commits ? b : a));
  const ratio = best.lines / best.commits;
  if (ratio < 1000) return [];
  return [{
    kind: 'lines-per-commit',
    title: `${best.owner.name} owns ${num(Math.round(ratio))} lines per commit`,
    detail: [{ text: `${num(best.lines)} lines from ${num(best.commits)} ${best.commits === 1 ? 'commit' : 'commits'}, the highest ratio among the top owners.` }],
  }];
}

// The owner with the most lines owned per line written (at least 100 owned).
function leverageOddity(stats) {
  const rows = stats.owners.filter((o) => o.owner && o.written > 0 && o.lines >= 100);
  if (rows.length === 0) return [];
  const best = rows.reduce((a, b) => (b.lines / b.written > a.lines / a.written ? b : a));
  const ratio = best.lines / best.written;
  if (ratio < 10) return [];
  return [{
    kind: 'leverage',
    title: `${best.owner.name} owns ${num(Math.round(ratio))} lines for every line written`,
    detail: [{ text: `${num(best.lines)} lines owned from ${num(best.written)} written.` }],
  }];
}

function demolition(stats) {
  const d = stats.deletions;
  if (!d) return [];
  const found = [];
  const top = d.topRemovers[0];
  if (top && top.owner && top.lines > 0) {
    found.push({
      kind: 'demolition',
      title: `${top.owner.name} has removed ${num(top.lines)} lines that belonged to others`,
      detail: [{ text: `More than anyone else, against ${num(top.ownRemoved)} of their own.` }],
    });
  }
  const line = d.mostRemovedLine;
  if (line && line.lines > 1) {
    found.push({
      kind: 'most-removed-line',
      title: 'The most-deleted line',
      detail: [
        line.binary ? { code: line.path } : { code: JSON.stringify(line.text) },
        { text: ` has been removed ${num(line.lines)} times. It belongs to ${line.owner ? line.owner.name : 'no one'}.` },
      ],
    });
  }
  if (d.restored.lines > 0) {
    found.push({
      kind: 'restored',
      title: `${num(d.restored.lines)} ${d.restored.lines === 1 ? 'line was' : 'lines were'} added again after being deleted`,
      detail: [{ text: `Each went straight back to its original owner (${num(d.restored.hashes)} distinct ${d.restored.hashes === 1 ? 'line' : 'lines'}).` }],
    });
  }
  return found;
}

function unattributed(stats) {
  const none = stats.owners.find((o) => !o.owner);
  if (!none) return [];
  return [{
    kind: 'unattributed',
    title: `${num(none.lines)} ${none.lines === 1 ? 'line has' : 'lines have'} no owner`,
    detail: [{ text: 'No commit adds them in a form git can reproduce, for example lines from merges git cannot redo automatically (octopus merges).' }],
  }];
}

export function isBot(owner) {
  return BOT.test(owner.name) || BOT.test(owner.email);
}

function ownerName(line) {
  return line.owner ? line.owner.name : 'no one';
}

function names(list) {
  if (list.length <= MAX_NAMES) return list.join(', ');
  return `${list.slice(0, MAX_NAMES).join(', ')}, and ${list.length - MAX_NAMES} more`;
}

function listCode(list) {
  const shown = list.slice(0, MAX_NAMES);
  const parts = [];
  shown.forEach((c, i) => {
    if (i > 0) parts.push({ text: ', ' });
    parts.push({ code: c });
  });
  if (list.length > MAX_NAMES) parts.push({ text: `, and ${list.length - MAX_NAMES} more` });
  return parts;
}

function num(n) {
  return Number(n).toLocaleString('en-US');
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
