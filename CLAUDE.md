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

Pieces (details in [agent_docs/architecture.md](agent_docs/architecture.md)):

```
git history (1..n repos) ──> index / add ──> .db ──> blame (optional)
                                              │
                                              └──> collectStats ──> summary, report
                                                                     ├─ owners, lines, pie, cross-repo heatmap
                                                                     ├─ spider charts, three-way comparison
                                                                     ├─ leverage, demolition, survival
                                                                     └─ outlook (projections), oddities
```

## Layout

| Path                | Role                                                                                                                            |
|---------------------|---------------------------------------------------------------------------------------------------------------------------------|
| `bin/ownh.js`       | CLI: `index`, `add`, `summary`, `report`, `blame`                                                                               |
| `src/indexer.js`    | history walk, first-introducer upsert, HEAD scoring                                                                             |
| `src/git.js`        | git subprocesses: `log -p`, `diff` vs empty tree, `cat-file`, `blame`                                                           |
| `src/exclude.js`    | exclude-file parsing, patterns to git pathspecs                                                                                 |
| `ownh.exclude`      | optional default exclude list, git-ignored                                                                                      |
| `src/db.js`         | SQLite schema (`node:sqlite`)                                                                                                   |
| `src/hash.js`       | line and file hash                                                                                                              |
| `src/stats.js`      | `collectStats`: every number summary and report show                                                                            |
| `src/summary.js`    | plain-text summary                                                                                                              |
| `src/report.js`     | report files: leaderboard.md, JSON, CSV                                                                                         |
| `src/charts.js`     | SVG pie, cross-ownership heatmap, radar charts                                                                                  |
| `src/oddities.js`   | "Oddities" report section: odd findings derived from the stats                                                                  |
| `src/profiles.js`   | data for the radar charts (owner and repository profiles)                                                                       |
| `src/timeline.js`   | quarterly series and projections for the report's Outlook                                                                       |
| `src/outlook.js`    | Outlook statements and charts (shared by Markdown and HTML)                                                                     |
| `src/churn.js`      | churn analyses: true ownership history, deletions, survival (Kaplan-Meier)                                                      |
| `src/sections.js`   | leverage, code demolition, and code survival report pieces                                                                      |
| `src/archetypes.js` | rule-based owner groups (principal, inactive, absentee, leverage, demolition, automation)                                       |
| `src/ai.js`         | optional `--ai` prose: pseudonymized facts, OpenAI-compatible call (hosted or local), number guard, cache                       |
| `src/html.js`       | self-contained report.html (inline charts, sortable tables)                                                                     |
| `src/blame.js`      | `ownh blame`: git blame per HEAD file, parallel, resumable                                                                      |
| `src/sample.js`     | deterministic blame file sample                                                                                                 |
| `test/`             | fixture repo builder and `node:test` suite                                                                                      |
| `docs/`             | pitch site, served at https://ownh.org (GitHub Pages)                                                                           |
| `docs/CNAME`        | GitHub Pages custom domain (`ownh.org`); keep it                                                                                |
| `docs/sample/`      | sample report of six generated demo repos (`scripts/demo-repos.js`); generated, run `npm run sample`                            |
| `whitepaper/`       | LaTeX source of the method whitepaper; built to `docs/ownh-whitepaper.pdf`, never edit the PDF                                  |
| `docs/og.png`       | link-preview image, rendered from `scripts/og.svg`                                                                              |
| `scripts/`          | `build-sample.js`, `demo-repos.js` (sample), `build-whitepaper.js`, `og.svg` (preview), `screenshot.mjs` (headless Firefox)     |
| `README.md`         | human-facing deadpan pitch and usage                                                                                            |
| `LICENSE`           | Apache License 2.0 (canonical text, unmodified)                                                                                 |
| `agent_docs/`       | architecture, research, design, gotchas (linked below)                                                                          |
| `AGENTS.md`         | symlink to this file                                                                                                            |

The pitch site is `docs/index.html`, published by GitHub Pages from `docs/` on the
default branch of https://github.com/wistrand/ownh to https://ownh.org (DNS at
Namecheap: apex A/AAAA records to GitHub Pages, `www` CNAME to
`wistrand.github.io`). Editing `docs/` and pushing updates the live site.

Runtime is Node.js, no npm dependencies. Results are stored in SQLite, one `.db`
per analysis; reports are generated from it.

## Commands

```bash
bin/ownh.js index --db out.db [--exclude-file f]... [--no-excludes] [--force] <repo>...
bin/ownh.js add --db out.db [--exclude-file f]... [--no-excludes] <repo>...   # same excludes as the .db
bin/ownh.js summary --db out.db [--top 10]
bin/ownh.js report --db out.db [--out dir] [--top 20] [--ai | --ai-dry-run] [--no-cache]   # default out: report/out/; reuses stats-cache.json there
bin/ownh.js blame --db out.db [--jobs n] [--sample files] [--repo name]...   # slow; resumable
npm test        # only when the user asks
npm run sample  # regenerate docs/sample/ after changing report output
rsvg-convert scripts/og.svg -o docs/og.png   # after editing the preview image
npm run whitepaper  # rebuild docs/ownh-whitepaper.pdf (pdflatex) after editing whitepaper/
```

## Docs

- [agent_docs/research.md](agent_docs/research.md): prior art on line-level ownership and content hashing, with sources. Read before claiming anything about the literature.
- [agent_docs/design.md](agent_docs/design.md): the satire concept, naming, the absurdities to surface, presentation ideas, the pitch copy, and the pitch site and whitepaper rules. Read before editing `docs/` or `whitepaper/`.
- [agent_docs/architecture.md](agent_docs/architecture.md): how it works: history walk, database schema, blame, statistics, reports, sample; the decisions behind them, verification, performance, open questions. Read before changing `src/`.
- [agent_docs/gotchas.md](agent_docs/gotchas.md): traps in the hashing method and in the tone. Skim before writing algorithm code or any public copy.

## Invariants

- Owner of a hash is the commit with the smallest `(author_time, repo name, topo)` key that adds it (`UPSERT_HASH` in `src/indexer.js`). Never compare `repos.id` for the tiebreak: ids follow insertion order and `add` appends.
- `add` must give the same result as a full `index` of all repos. Anything order-dependent (tiebreaks, identity display names) breaks that.
- No normalization. A line is the exact bytes between `\n` separators: whitespace, blank lines, and a trailing `\r` (CRLF) are all part of the line. A binary file is one line: the SHA-256 of its full content. Binary means whatever git decides (attributes plus content check), never our own heuristic. Lines are hashed as raw bytes, never decoded first (`BYTES` in `src/git.js`). History and HEAD must split, classify, exclude, and hash identically (`src/hash.js`, `lines()` and `binaryPaths()` in `src/git.js`; each side of a "Binary files differ" diff is classified on its own in `src/indexer.js`).
- One shared first-introducer table across all input repos. A single repo is the n=1 case, never a separate code path.
- AI-written report text (`--ai`) may only state numbers OWNH computed; `checkAnswer` in `src/ai.js` enforces it. Never send names, emails, repository names, dates, absolute counts, or code text to the model: tokens, percentages, and size bands only (`buildFacts`). Review a new database's payload with `--ai-dry-run` before the first real request.
- Never publish invented numbers. Every percentage, rank, or count in user-facing material comes from a reproducible run on a real repo. Placeholders are marked as placeholders.
- Never "fix" the absurdities. The algorithm stays faithfully naive (first introducer of a hash owns it); the satire is the output of an honest implementation of a bad idea.
- Same repos, same output. Runs must be deterministic, independent of the order repos are passed in, so a reader can reproduce the leaderboard.
- Public copy stays deadpan. Never wink, explain the joke, or add "satire" disclaimers inside the pitch itself. The reveal is the leaderboard.
- Research claims in public copy must be traceable to a source listed in [agent_docs/research.md](agent_docs/research.md).

## Conventions

- Never run tests unless the user asks; never run formatters or linters (user rule).
- Never install packages; ask the user or write a script for them.
- Never name the locally analyzed repositories, their paths, or local database files in docs (CLAUDE.md, README, agent_docs/, docs/, whitepaper/). Describe them generically ("the largest repo", "three repos").
- Reports go in `report/<database name>/`, never directly in `report/`.
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
