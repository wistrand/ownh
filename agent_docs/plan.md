# Plan: OWNH analyzer and reports

> Status: Phase 1 done; fixture tests pass; smoke run on real repos done.

## Goal

A tool that computes line-hash ownership across one or more git repositories and produces
the leaderboard, pie chart, cross-repository ownership view, and three-way comparison
described in [design.md](design.md), so the absurd numbers are genuine.

## Current state

Phase 1 indexer and a plain-text summary exist (`src/indexer.js`, `src/summary.js`,
CLI in `bin/ownh.js`). Concept, naming, and pitch are in [design.md](design.md);
background in [research.md](research.md).

## Approach

Runtime: Node.js.

- Input is a list of repositories. All repos share one first-introducer table,
  so an identical line in two repos has one owner (the "cross-repository synergy"
  from the pitch). A single repo is the n=1 case, not a separate mode.
- Each repo's history is read with `git log -p --reverse --topo-order --no-merges`.
  Every added line is hashed as-is (SHA-256, no normalization) and upserted into `line_hashes`
  keeping the smallest key `(author_time, repo_id, topo)`. Owner is the author of
  the commit holding that key. Taking the minimum is equivalent to walking one
  merged timeline but doesn't need one, and is independent of processing order.
  See `UPSERT_HASH` in `src/indexer.js`. Binary diffs carry only blob ids
  (`--full-index`); those blobs are read with `cat-file --batch` after the walk
  and upserted as one-line files.
- Score each repo's current tree (HEAD): each line's owner is the owner of its
  hash. Aggregate by owner and by hash, overall and per repo, and record which
  repo the owning line came from (so reports can show one repo "owning" another).
- For the comparison, compute commit-count ownership and `git blame` ownership on
  the same HEAD trees, per repo and combined.
- Identity: map author by email, with an optional mailmap so one person with two
  emails isn't split (respect each repo's `.mailmap`; one identity map spans all
  repos).
- Keep it naive on purpose (see invariants in CLAUDE.md).

### Phase 1 decisions

Defaults chosen when Phase 1 was built. Each can be revisited.

| Question             | Decision                                                                                                                                                                                                                             |
|----------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Normalization        | None (user decision). Lines are the exact text between `\n`s, so indentation, trailing spaces, and CRLF `\r` all make a different line.                                                                                              |
| Blank lines          | A line like any other (user decision). `""` and `"\r"` are different lines.                                                                                                                                                          |
| Merge commits        | Skipped (`--no-merges`). Lines that exist only in a merge resolution are unattributed.                                                                                                                                               |
| Renames              | `-M`; a pure rename adds no lines. Copies count as new additions, owned by the first introducer.                                                                                                                                     |
| Binary files         | One line per file: SHA-256 of the full content (user decision). Git decides what is binary: "Binary files differ" in history, `diff --numstat` against the empty tree at HEAD.                                                       |
| Submodules           | Skipped (mode 160000).                                                                                                                                                                                                               |
| Cross-repo timestamp | Author date. Tiebreak by repo name, then topo index within the repo.                                                                                                                                                                 |
| Repo name            | Directory basename (minus `.git`). Duplicate names are an error.                                                                                                                                                                     |
| Input form           | Repo paths as CLI positionals.                                                                                                                                                                                                       |
| Reruns               | `index` always rebuilds (`--force` to overwrite). `add` appends new repos to an existing `.db` in one transaction; refuses a different exclude list or an existing repo name. Updating a repo already in the `.db` is not supported. |
| Identity             | Lowercased email after `--use-mailmap`. Display name is the name on the most commits for that email across the `.db`, ties to the smallest name (user decision). Recomputed after every run from `commits.author_name`.              |
| Line text encoding   | Decoded as UTF-8; invalid bytes become U+FFFD in both diff and HEAD paths, so they still match.                                                                                                                                      |
| Excluded files       | Exclude file(s), gitignore-like patterns (user decision). Default `ownh.exclude` (`dist/`, two generated shoreline files, maze embeddings JSON). Applied as git exclude pathspecs to history and HEAD.                               |
| Progress             | Every 5 s per phase to stderr (history commits n/total, HEAD files n/total).                                                                                                                                                         |

Inferred, not verified: reading diffs is cheaper than hashing every blob at every
commit, and gives the same first-introducer result.

## Storage

Decision: SQLite through Node's built-in `node:sqlite`. Reports are files
generated from the database.

- One `.db` file per analysis. It is the reproducible artifact behind every
  published number: hand it over and anyone can rerun the report queries.
- The history walk does keyed "seen this hash?" lookups against the shared
  first-introducer table instead of holding every distinct line in memory.
- Reports are SQL queries over the same tables, so new reports need no indexer
  changes.
- Rejected: Postgres (server and setup for a single-writer local batch job;
  revisit only for a shared dashboard), plain JSON/NDJSON (hand-rolled lookups
  and joins, full rescans per report).
- Reports (leaderboard Markdown, SVG charts, JSON/CSV) are
  derived outputs. Always regenerate them from the `.db`; never edit them by hand.

Sketch of the tables (names and columns not final):

| Table         | Holds                                                         |
|---------------|---------------------------------------------------------------|
| `runs`        | tool version and run times for this `.db`                     |
| `repos`       | input repositories and the last commit processed per repo     |
| `commits`     | repo, commit hash, author identity and name, timestamp        |
| `identities`  | email to person mapping (from `.mailmap`)                     |
| `line_hashes` | hash, binary flag, line text (NULL for binary), first commit  |
| `head_lines`  | repo, path, line number, hash, blame author                   |

`package.json` pins Node >= 22.13. Inferred, not verified: that is the first
release with `node:sqlite` unflagged. Developed against Node 26.

## Testing methodology

Agents run tests only when the user asks. Provide a small fixture repo builder
script with known history and expected ownership, for the user to run.

- `test/fixtures.js` builds two repos (alpha, beta) with fixed author dates.
  The header comment lists the scripted history.
- `test/index.test.js` asserts the owner of every HEAD line, the trim/none
  difference, mailmap merging, repo-order independence, the `--force` guard,
  excludes, and `add` matching a full index (including the cross-repo tiebreak).
- Run with `npm test` (`node --test test/`).

## Phases

### Phase 1: indexer

- [x] SQLite schema and `.db` creation via `node:sqlite`
- [x] History walk, hash, first-introducer table
- [x] Multi-repo input with one shared table (min-key upsert instead of a merged timeline)
- [x] HEAD scoring and per-owner / per-hash aggregation (overall and per repo), plain-text output (`ownh summary`)
- [x] `npm test` passes (4 tests)
- [x] Smoke run: 4 sibling repos (~1.8k commits, ~1.1M HEAD lines) index in about 15 s, summary in about 8 s, zero unattributed lines. The `.db` is about 500 MB.
- [x] Large run: 7 repos including `main` (342k commits, 11.7M HEAD lines), 12.5M HEAD lines total. Index about 12.5 min, summary about 2 min, `.db` about 11.9 GB.

**Verify:** fixture repos give the expected owner for each scripted line,
including a line first written in repo A and later copied into repo B;
two runs produce identical output regardless of the order repos are passed in.

### Phase 2: reports

- [x] Report generation reads only from the `.db` (`ownh report`, `src/report.js`)
- [x] One stats module (`collectStats` in `src/stats.js`) feeds both `summary` and
      `report`, so their numbers can't diverge
- [x] Leaderboard (`leaderboard.md`): top owners, top lines with their literal
      text, per-repo owners with a "commits here" column
- [x] Pie chart "Ownership by line hash" (`ownership-by-line-hash.svg`): top 5
      lines plus "everything else"; pies stay at 6 segments or fewer
- [x] Cross-repository ownership (user request): repo x origin-repo heatmap
      (`cross-ownership.svg`), `cross-ownership.csv`, and per repo the share owned
      from other repos and the share owned by people with no commits there
- [x] Data files: `report.json`, `owners.csv`, `lines.csv`
- [x] `report.html` (user request): self-contained page with the leaderboard
      content, inline charts (hover tooltips), sortable tables, collapsible
      per-repo sections; checked by eye in headless Firefox
- [x] Progress on stderr: owner pass per repo, large repos split into ~1M-line
      path ranges; top lines counted per hash range (16 ranges). About 85 s on
      the 22-repo `.db`, almost all of it `main`.
- Dropped (user decision): generated CODEOWNERS.

**Verify:** `report files agree with the summary` test; charts rendered with
`rsvg-convert` and checked by eye on the 22-repo `.db`.

### Phase 3: three-way comparison

- [ ] Commit-count ownership
- [ ] Blame ownership
- [ ] Side-by-side table naming each method's top owner

**Verify:** on the fixture, each method's top owner is what the scripted history implies.

### Phase 4: real run and pitch

- [ ] Run on one or more real repos chosen by the user
- [ ] Replace placeholders in the pitch with real figures

## Open questions

- `ownh update` for repos already in a `.db` (new commits since the stored
  `head`): feasible with the same min-key upsert plus replacing that repo's
  `head_lines`. Not built.

- Phase 1 decisions above are defaults unless marked as a user decision. Most
  likely to change: whether merge-only lines should go to the merger.
- Which generated/vendored files to add to `ownh.exclude` beyond `dist/` and the
  shoreline stats page (maze's `conf/tql-schema-embeddings.json` is the next
  biggest outlier, about half the HEAD lines of the first smoke run).
- `.db` size: about 450 bytes per HEAD line on the smoke run. Storing hashes as
  32-byte BLOBs and interning paths would shrink it if size becomes a problem.
- Generated files dominate real repos: in the smoke run one JSON embeddings file
  was about half of all HEAD lines. Led to the exclude list.
- Large public-code "go global" runs (World of Code scale): out of scope unless
  the user asks; multi-repo covers the joke at org scale.
- Which real repos to run on, and whether naming individuals in output needs
  anonymization before presenting.
