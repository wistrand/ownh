Guidance for agents working in this repo. Read this first, then the relevant
file in `agent_docs/`.

## What this is

OWNH ("Objective Weighted Normalized Heuristics") is a satire of code ownership
presented as a serious enterprise framework. It assigns each line in one or more
repositories to the first contributor across their combined history to produce that line's exact content hash.
The method is deliberately naive: lone `}`, blank lines, and boilerplate collapse
onto one "owner", formatters and renames transfer ownership wholesale, and the
resulting leaderboard exposes how arbitrary any ownership metric is. The point
lands only if the tool is presented deadpan and the numbers come from real repos.

Planned pieces (nothing is built yet, see [agent_docs/plan.md](agent_docs/plan.md)):

```
git history (1..n repos) ──> line-hash indexer ──> first-introducer table ──> reports
                                                                             ├─ leaderboard
                                                                             ├─ "ownership by line hash" pie chart
                                                                             ├─ cross-repository ownership
                                                                             └─ three-way comparison (commits / blame / hash)
```

## Layout

| Path          | Role                                                  |
|---------------|-------------------------------------------------------|
| Path               | Role                                                         |
|--------------------|--------------------------------------------------------------|
| `bin/ownh.js`      | CLI: `index`, `summary`                                      |
| `src/indexer.js`   | history walk, first-introducer upsert, HEAD scoring          |
| `src/git.js`       | git subprocesses: `log -p`, `diff` vs empty tree, `cat-file` |
| `src/exclude.js`   | exclude-file parsing, patterns to git pathspecs              |
| `ownh.exclude`     | default exclude list (used when no `--exclude-file`)         |
| `src/db.js`        | SQLite schema (`node:sqlite`)                                |
| `src/hash.js`      | line hash                                                    |
| `src/stats.js`     | `collectStats`: every number summary and report show         |
| `src/summary.js`   | plain-text summary                                           |
| `src/report.js`    | report files: leaderboard.md, JSON, CSV                      |
| `src/charts.js`    | SVG pie and cross-ownership heatmap                          |
| `src/blame.js`     | `ownh blame`: git blame per HEAD file, parallel, resumable    |
| `src/sample.js`    | deterministic blame file sample                              |
| `src/html.js`      | self-contained report.html (inline charts, sortable tables)  |
| `test/`            | fixture repo builder and `node:test` suite                   |
| `docs/index.html`  | pitch site (static, hand-written, no real data)              |
| `README.md`        | human-facing deadpan pitch and usage                         |
| `agent_docs/`      | research, design, plan, gotchas (linked below)               |
| `AGENTS.md`        | symlink to this file                                         |

Runtime is Node.js, no npm dependencies. Results are stored in SQLite, one `.db`
per analysis; reports are generated from it.

## Commands

```bash
bin/ownh.js index --db out.db [--exclude-file f]... [--no-excludes] [--force] <repo>...
bin/ownh.js add --db out.db [--exclude-file f]... [--no-excludes] <repo>...   # same excludes as the .db
bin/ownh.js summary --db out.db [--top 10]
bin/ownh.js report --db out.db --out report/ [--top 20]
bin/ownh.js blame --db out.db [--jobs n] [--sample files] [--repo name]...   # slow; resumable
npm test        # only when the user asks
```

## Docs

- [agent_docs/research.md](agent_docs/research.md): prior art on line-level ownership and content hashing, with sources. Read before claiming anything about the literature.
- [agent_docs/design.md](agent_docs/design.md): the satire concept, naming, the absurdities to surface, presentation ideas, and the pitch copy.
- [agent_docs/plan.md](agent_docs/plan.md): phased plan for the analyzer and reports, plus open questions.
- [agent_docs/gotchas.md](agent_docs/gotchas.md): traps in the hashing method and in the tone. Skim before writing algorithm code or any public copy.

## Invariants

- Owner of a hash is the commit with the smallest `(author_time, repo name, topo)` key that adds it (`UPSERT_HASH` in `src/indexer.js`). Never compare `repos.id` for the tiebreak: ids follow insertion order and `add` appends.
- `add` must give the same result as a full `index` of all repos. Anything order-dependent (tiebreaks, identity display names) breaks that.
- No normalization. A line is the exact bytes between `\n` separators: whitespace, blank lines, and a trailing `\r` (CRLF) are all part of the line. A binary file is one line: the SHA-256 of its full content. Binary means whatever git decides (attributes plus content check), never our own heuristic. History and HEAD must split, classify, exclude, and hash identically (`src/hash.js`, `lines()` and `binaryPaths()` in `src/git.js`).
- One shared first-introducer table across all input repos. A single repo is the n=1 case, never a separate code path.
- Never publish invented numbers. Every percentage, rank, or count in user-facing material comes from an actual run on a named repo. Placeholders are marked as placeholders.
- Never "fix" the absurdities. The algorithm stays faithfully naive (first introducer of a hash owns it); the satire is the output of an honest implementation of a bad idea.
- Same repos, same output. Runs must be deterministic, independent of the order repos are passed in, so a reader can reproduce the leaderboard.
- Public copy stays deadpan. Never wink, explain the joke, or add "satire" disclaimers inside the pitch itself. The reveal is the leaderboard.
- Research claims in public copy must be traceable to a source listed in [agent_docs/research.md](agent_docs/research.md).

## Conventions

- Never run tests unless the user asks; never run formatters or linters (user rule).
- Never install packages; ask the user or write a script for them.
- The name is always `OWNH` in prose; the expansion appears once, near the top of a piece.

## Documentation Style

- Markdown links for doc references you want an agent to follow, not backticks.
  Backticks are fine for source paths in tables and inline code. Align table columns.
- No AI-isms (no "powerful", "seamlessly", "leverage", rule-of-three, "not just
  X but Y") in agent docs. No em dashes or emojis in project copy. State the point directly.
- Exception: the deadpan pitch copy imitates corporate marketing on purpose. Keep that voice inside the pitch only, never in agent docs.
- Concise; assume the agent is competent. Add only what it can't infer.
- State each rule on its own line as always/never.
- Mark inferred claims and open questions; don't present a guess as a fact.
- Keep this file the routing entry point; move detail into agent_docs/.
