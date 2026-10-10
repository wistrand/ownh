# Architecture

How OWNH works: the history walk, the database, blame, the statistics, and the
reports. Concept and tone are in [design.md](design.md); traps and diagnosed bugs
in [gotchas.md](gotchas.md); global invariants in [CLAUDE.md](../CLAUDE.md).

## Contents
- Overview
- Commands
- Indexing (history walk)
- Scoring HEAD
- Database
- Blame
- Statistics
- Reports
- AI prose
- Sample report and site
- Decisions
- Verification
- Performance
- Open questions
- Dropped

## Overview

```
repos ──> index / add ──> .db (SQLite) ──> blame (optional) ──> .db
                              │
                              └──> collectStats ──> summary (text)
                                                └──> report: report.html, leaderboard.md, SVG, JSON, CSV
```

One `.db` per analysis is the reproducible artifact behind every number:
reports are derived from it and regenerated, never edited. Runtime is Node.js
(>= 22.13, for unflagged `node:sqlite`; inferred, not verified) with no npm
dependencies. Git does all repository work through subprocesses (`src/git.js`).

**Key files**: `bin/ownh.js` (CLI), `src/indexer.js` (`index`, `add`,
`indexHistory`, `indexHead`), `src/git.js` (`log`, `blame`, `catBlobs`,
`headFiles`, `binaryPaths`, `blameClone`), `src/db.js` (`SCHEMA`),
`src/stats.js` (`collectStats`), `src/report.js` (`report`).

## Commands

| Command   | Does                                                                                       |
|-----------|--------------------------------------------------------------------------------------------|
| `index`   | New `.db` from repos (`--force` to overwrite). One transaction.                             |
| `add`     | Appends repos to an existing `.db`; same result as indexing all at once. One transaction.  |
| `blame`   | Fills per-line blame authors; slow, parallel, resumable, optional `--sample N`.            |
| `summary` | Plain-text summary to stdout.                                                              |
| `report`  | Report files into `--out`, default `report/<db name>/`.                                    |

Excludes: `--exclude-file` (repeatable), `--no-excludes`, or the optional,
git-ignored `ownh.exclude` next to the tool (missing is fine; an explicit
missing file is an error). Patterns become git exclude pathspecs
(`toPathspecs` in `src/exclude.js`), applied identically to history and HEAD.
`add` refuses a different exclude list than the `.db` was built with.

All long commands report progress on stderr every 5 seconds.

## Indexing (history walk)

`indexHistory` in `src/indexer.js` reads `log()` from `src/git.js`:
`git log --reverse --topo-order --full-history --diff-merges=remerge -p -M
--full-index --unified=0 --diff-algorithm=myers` plus pinned output options.

- **Ownership rule.** Every added line is hashed exactly as written (SHA-256,
  `src/hash.js`; no normalization) and upserted into `line_hashes`, keeping the
  smallest key `(author_time, repo name, topo)` (`UPSERT_HASH`). The owner is the
  author of the commit holding that key. Taking the minimum gives the same answer
  as one merged timeline, whatever order repos and commits are processed in,
  which is what makes `add` equal to a full `index`.
- **Merges.** Diffed with remerge: git redoes the automatic merge and diffs it
  against the recorded result, so a merge's added lines are what its author
  wrote by hand (conflict resolutions, new code). Taking one side unchanged adds
  nothing. Merges are stored with `commits.is_merge = 1` and excluded from commit
  counts, activity, and contributor checks; their removals are not recorded.
- **Binary files.** Git decides what is binary ("Binary files differ"). The
  diff carries only blob ids (`--full-index`); blobs are read afterwards with
  `cat-file --batch` and hashed whole: one binary file is one line.
- **Churn.** Every added and removed text line (and binary blob) is counted per
  `(hash, repo, quarter, author)` into `churn`, flushed per commit
  (`UPSERT_CHURN`). Removals inside merges are skipped.
- **Counters.** `commits.added_lines` and `added_blank` (every added occurrence,
  before per-commit dedup) feed leverage and the blank-line outlook.
- **Identities.** One identity per lowercased email after `--use-mailmap`.
  Display name is recomputed after every run as the name on the most commits
  (`refreshDisplayNames`), so it does not depend on processing order.
- **Why diffs, not blobs.** Reading `-U0` diffs is assumed cheaper than hashing
  every blob at every commit and gives the same first-introducer result
  (inferred, not measured).
- **Guards.** Shallow clones are refused (`isShallow`). Submodule entries are
  skipped. Every git stream is killed if its reader stops early (`run()` and
  `gitLines()` in `src/git.js`).

## Scoring HEAD

`indexHead` lists files at the stored head as a diff against the empty tree
(`headFiles`, so the same pathspecs apply), reads blobs with `catBlobs`, splits
text on `\n` only, and stores one `head_lines` row per line with its hash. Binary
files (per `binaryPaths`, git's own decision) are one row. Ownership is not
stored on `head_lines`; it is a join through `line_hashes` at query time.

## Database

`src/db.js`. Fresh `index` runs skip fsync (it can simply be rerun); writes to
an existing `.db` keep default durability. All connections set a 10-minute busy
timeout so a report and a blame run can overlap.

| Table         | Holds                                                                                           |
|---------------|-------------------------------------------------------------------------------------------------|
| `runs`        | tool version, exclude patterns, start and finish time per `index`/`add`                         |
| `repos`       | name (directory basename, unique), path, stored head                                            |
| `identities`  | lowercased email, display name                                                                  |
| `commits`     | repo, sha, topo, author time, identity, author name, `added_lines`, `added_blank`, `is_merge`   |
| `line_hashes` | hash, binary flag, text (NULL for binary), first-introducer key, owning commit, path            |
| `head_lines`  | repo, path, line number, hash, blame author                                                     |
| `churn`       | hash, repo, quarter, author, lines added, lines removed                                         |
| `blame_files` | files whose blame is stored (created by `blame`)                                                |
| `blame_repos` | per repo: blame sample size, or NULL for full (created by `blame`)                              |

Older databases missing `churn` or the newer `commits` columns still report
(features degrade), but `add` refuses them: rebuild with `index`.

## Blame

`src/blame.js`. Fills `head_lines.blame_identity_id` from `git blame --porcelain`
at each repo's stored head, in parallel (`--jobs`, default CPU count).

- Runs in a throwaway bare `--shared` clone with a commit-graph and changed-path
  Bloom filters for the stored head (`blameClone`); about 6x faster on a
  342k-commit repo, and the user's repos are not modified. `.mailmap` comes from
  the head via `mailmap.blob`.
- Resumable: finished files go to `blame_files`, committed every 200 files.
  Binary files are recorded as done without lines. Failures are retried on the
  next run.
- `--sample N`: repos with more than N files blame a fixed pseudo-random sample
  (`samplePaths` in `src/sample.js`: the N paths with the smallest SHA-256).
  Reports then show `~share ±margin`: a ratio estimator over files with a 95%
  margin (`blameEstimate` in `src/stats.js`). A later run without `--sample`
  completes the repo and makes it exact.

## Statistics

`collectStats` in `src/stats.js` produces every number `summary` and `report`
show, so they cannot disagree.

- **One pass over HEAD lines** grouped by repo, owner, origin repo, and quarter
  first written. Large repos are split into ~1M-line path ranges for progress.
  Gives owners, cross-repo origins, non-contributor ownership, and per-repo
  breakdowns.
- **Top lines** are counted per hash range (16 ranges, index-only), then joined
  to owners for the winners only.
- **Three methods** (`collectMethods`): top owner by non-merge commit count, by
  blame (exact or estimated), and by line hash, per repo and overall, with an
  agree flag.
- **Timeline** (`src/timeline.js`, `buildTimeline`): quarterly series. With
  `churn` it is a true history (net added minus removed per owner, checked
  against the HEAD line count); without it, surviving lines by first-written
  quarter. Projections take the least-squares slope of the last 12 quarters,
  continue it from the latest value, and report R². "Now" is the newest commit's
  quarter, not the clock.
- **Churn analyses** (`src/churn.js`): deletions (who removes whose lines, the
  most-removed line, lines re-added after deletion) and survival. Survival pairs
  removals with the oldest copies of a line first (copies are
  indistinguishable), then computes per-owner Kaplan-Meier curves and half-lives,
  extrapolated exponentially when the curve never reaches 50%.
- **Leverage**: lines owned per line written (`commits.added_lines`).

## Reports

`report()` in `src/report.js` writes into `report/<db name>/` by default. Every report names
its database and generation time (UTC) in the header and in `report.json`
(`generated`); `SOURCE_DATE_EPOCH` overrides the clock for reproducible output.

| File                            | Content                                                                 |
|---------------------------------|-------------------------------------------------------------------------|
| `report.html`                   | self-contained page; inline SVG charts, sortable tables, section anchors |
| `leaderboard.md`                | the same content in Markdown                                            |
| `report.json`                   | the full stats object                                                   |
| `owners.csv`, `lines.csv`, `cross-ownership.csv`, `methods.csv` | data tables                             |
| `ownership-by-line-hash.svg`    | pie, top 5 lines plus everything else (never more than 6 segments)      |
| `cross-ownership.svg`           | repo x origin-repo heatmap                                              |
| `owner-profile.svg`, `repo-profile.svg` | radar charts, at most 3 series                                  |
| `ownership-outlook.svg`, `blank-line-outlook.svg`, `code-survival.svg` | trend and survival charts |

Section order: principal owners, ownership profiles, principal lines,
cross-repository ownership, three ways to own, leverage, code demolition, code
survival, outlook, oddities, repositories, excluded patterns.

- Charts (`src/charts.js`) use plain hex colors in class rules with a dark-mode
  media block, never CSS variables, so rsvg and slide tools render them.
- Outlook statements and charts are shared by Markdown and HTML
  (`src/outlook.js`); leverage, demolition, and survival pieces likewise
  (`src/sections.js`); radar data in `src/profiles.js`.
- Oddities (`src/oddities.js`) are facts derived from the stats; each claim is
  checked by the code that prints it.
- Stats cache (`cachedStats` in `src/report.js`): `collectStats` is nearly all
  of a report's run time, so its output is kept in `stats-cache.json` in the
  report directory. The key is the database file's size and mtime, `--top`, and
  a hash of `STATS_SOURCES` (the modules that compute stats). Edits to rendering
  code reuse the cache; a new module that `collectStats` imports must be added
  to `STATS_SOURCES`. Fresh stats are round-tripped through JSON too, so cached
  and fresh runs render identically. `--no-cache` recomputes and neither reads nor writes the cache; the sample build
  never caches.

## AI prose

`src/ai.js`, enabled with `report --ai` (user request, opt-in). Writes three
things with any OpenRouter-compatible chat completions API: an executive
summary (top of the report), an OKR draft (after the Outlook), and names for
the owner archetypes. Archetype membership is rule-based (`src/archetypes.js`)
and always shown; the AI only names the groups.

- **Configuration:** `OWNH_AI_KEY` or `OPENROUTER_API_KEY`; optional
  `OWNH_AI_MODEL` (default `openai/gpt-6-luna`, user decision, `DEFAULT_MODEL`)
  and `OWNH_AI_BASE_URL` (default OpenRouter). Missing settings withhold the
  section with a reason; the rest of the report is unaffected.
- **Temperature:** 0 by default. Models that accept only their default (OpenAI
  reasoning models via api.openai.com return HTTP 400) are retried once
  without it; `OWNH_AI_TEMPERATURE=default` omits it from the start, or set a
  number.
- **Failures:** any API error (auth, quota, network) withholds the AI sections
  with the error message; the report is still written. Before this, an API
  error aborted the whole report.
- **Privacy (minimized, user decision):** `buildFacts` sends no names and no
  absolute numbers.
  - Owners, repositories, and quarters are tokens from `pseudonyms`, mapped
    back to names and quarter labels locally. Owner and repository tokens are
    numbered by first appearance in the facts (`[O1]`, `[O2]`, ...), never by
    rank or size, so the highest number only counts what was mentioned.
    Quarters are relative: `[T0]` is the newest commit's quarter, `[T-4]`,
    `[T+20]`.
  - Sizes are bands ("tens of millions" of lines; repositories and owners as "fewer than ten", "more than ten" (10 to 24), "dozens", "hundreds").
  - Outlook projections carry a `meaning` next to the status code. With the
    bare code, the model wrote a majority reached years ago ("reached",
    quarter `[T-47]`) as a milestone, "reached at 2015 Q1".
  - Percentages are only as precise as is safe: one decimal for shares of the
    whole codebase or of all removals (huge denominators), whole percents for
    shares of one repository, and words for any share of a count (`fraction`:
    "under a quarter", "about half", "over three quarters"; "one owner"). A
    first dry run showed why: "0.2% of owners" and "31.7% of repositories"
    pinned the exact owner and repository counts, and even 5% steps can pin
    small totals (2 of 6 is 35%, which no other small total gives).
  - Archetype rules are sent as `aiRule`, which never contains a number derived
    from the data (the leverage threshold depends on the line total).
  - Only tokens issued in the facts are accepted in the reply, quarters
    included, so the model can't invent a date.
  - `ai-request.json` is rewritten around each attempt, so after a temperature
    fallback or a retry it shows the request actually sent last.
  - Top lists are cut to three; top lines are described by kind, never text.
  - No attribution headers. On OpenRouter the body sets
    `provider.data_collection: "deny"` and `provider.zdr: true`
    (`OWNH_AI_ZDR=0` drops the ZDR restriction if no ZDR endpoint serves the
    model).
  - Every request is written to `ai-request.json` in the report directory
    (minus the key). `--ai-dry-run` writes it and sends nothing; use it to
    review the payload for a new database before the first real request.
  - Residual: the provider sees the API key's account, the IP address, the
    model choice, and the shape of the data (percentages, bands, trends).
- **Number guard:** `checkAnswer` rejects replies with numbers not in the facts
  (within 0.5, or 1% for counts over 100), unknown tokens, or the wrong shape.
  Up to 3 attempts with the problems fed back; then the section is withheld.
- **Cache:** `ai-cache.json` in the report directory, keyed by a hash of model,
  `PROMPT_VERSION`, and facts. Same data and model: no request, same text.
  Bump `PROMPT_VERSION` when the prompt changes.
- **Labeling:** every AI section says it was written by AI and names the model.
  In `report.html` a sparkle icon (`SPARKLE` in `src/html.js`, inline SVG, not
  an emoji) marks the AI section headings, each AI-written archetype name, and
  the AI disclaimer lines; Markdown uses "(AI-generated)" on headings and "(AI)"
  after archetype names. Anything rule-based (archetype membership) is unmarked.
- **Tests:** a fake `complete` function; nothing calls the network.

## Sample report and site

- `docs/index.html` is the hand-written pitch site (see [design.md](design.md)).
- `docs/sample/` is a real report of fictional data: `scripts/demo-repos.js`
  builds six repositories with about forty fictional authors over five and a
  half years from a seeded generator with fixed dates (founder import, copied
  services, shared headers, a formatter commit, a dependency bot, departures,
  rewrites, reverts, conflict merges). `npm run sample` rebuilds it; output is
  byte-identical across runs except the generation time.
- `scripts/screenshot.mjs` captures pages after scripted content has rendered
  (headless Firefox over WebDriver BiDi).

## Decisions

| Question         | Decision                                                                                                                                                                                                          |
|------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Normalization    | None (user decision). Indentation, trailing spaces, and CRLF `\r` make a different line.                                                                                                                          |
| Blank lines      | A line like any other (user decision). `""` and `"\r"` are different lines.                                                                                                                                       |
| Merge commits    | Walked with remerge (user decision); hand-written lines get an owner; not counted as commits.                                                                                                                     |
| Renames          | `-M`; a pure rename adds no lines. Copies are additions, owned by the first introducer.                                                                                                                           |
| Binary files     | One line per file, SHA-256 of the content (user decision). Git decides what is binary.                                                                                                                            |
| Submodules       | Skipped.                                                                                                                                                                                                          |
| Cross-repo order | Author date; tiebreak by repo name, then topo index.                                                                                                                                                              |
| Repo name        | Directory basename (minus `.git`); duplicates are an error.                                                                                                                                                       |
| Reruns           | `index` rebuilds; `add` appends new repos; updating a repo in place is not supported.                                                                                                                             |
| Display names    | Most-used name per email across the `.db` (user decision).                                                                                                                                                        |
| Line encoding    | Decoded as UTF-8 on both paths; invalid bytes become U+FFFD and still match.                                                                                                                                      |
| Excludes         | Gitignore-like patterns as git exclude pathspecs (user decision).                                                                                                                                                 |
| Storage          | SQLite via `node:sqlite`. Rejected: Postgres (server for a local batch job), JSON files.                                                                                                                          |
| Report location  | `report/<db name>/` (user preference).                                                                                                                                                                            |
| Input form       | Repo paths as CLI positionals; a single repo is the n=1 case, never a separate code path.                                                                                                                         |
| Progress         | Every 5 s per phase on stderr (commits n/total, files n/total, report passes).                                                                                                                                    |
| Naivety          | Deliberate: no context hashing, similarity matching, or trivial-line filtering (see design.md).                                                                                                                   |
| Commit counts    | Non-merge commits only; commits touching only excluded files are not walked, so not counted.                                                                                                                      |
| Blame            | Opt-in command, separate from `index` because it is slow; a repo's answer appears only when every file (or every sampled file) is done; the overall row is an estimate without a margin when any repo is sampled. |
| Stats            | One module (`collectStats`) feeds `summary` and `report`; reports read only from the `.db`, so new reports need no indexer changes.                                                                               |
| Charts           | Pies stay at 6 segments or fewer; radar charts at most 3 series; plain hex colors, no CSS variables.                                                                                                              |
| Projections      | Least-squares slope of the last 12 quarters continued from the latest value, R² stated; relative to the newest commit.                                                                                            |
| AI prose         | Opt-in `--ai`; aggregates and tokens only; every number verified; cached; labeled (user decision).                                                                                                                |

## Verification

- `npm test` (`node --test "test/*.test.js"`); agents run it only when asked.
  `test/fixtures.js` builds two repos with scripted history; the header comment
  lists it. Tests cover every HEAD line's owner, mailmap, repo-order
  independence, `--force`, excludes and pathspecs, `add` equal to `index`,
  display names, report/summary agreement, the three methods, blame sampling,
  history simplification, shallow clones, stream cleanup, large blobs,
  oddities, timeline math, and merge-resolution ownership.
- Charts are checked by eye: `rsvg-convert` for SVG files, `scripts/screenshot.mjs`
  for pages.
- History reconciliation: the Outlook note prints net added-minus-removed lines
  against the HEAD line count.

## Performance

Measured on real runs (repositories not named, see CLAUDE.md conventions):

- Index: about 12 minutes for a 342k-commit, 11.7M-line repo before churn was
  recorded; churn adds a noticeable but unmeasured share. Small repos take seconds.
- Database: about 450 bytes per HEAD line before churn; churn added about 20% on
  a 4M-line database.
- Blame with commit-graph: about 40 files per second on 16 cores for the large
  repo (about 20 minutes for 57k files).
- Report: about 1.5 minutes for 15M HEAD lines, dominated by the per-line owner
  join of the largest repo.
- Remerge walking costs nothing measurable, including on a repo with 4,200 merges.

## Open questions

- `ownh update` for repos already in a `.db` (new commits since the stored
  head): feasible with the same min-key upsert plus replacing that repo's
  `head_lines` and churn. Not built.
- Which generated or vendored files belong in an exclude list beyond `dist/`.
  In real runs a single generated data file was about half of all HEAD lines.
- `.db` size: hashes as 32-byte BLOBs and interned paths would shrink it.
- Lines "re-added after deletion" are counted per quarter, so common lines
  (blanks, braces) dominate the figure; it overstates actual reverts.
- Pitch copy in [design.md](design.md) still has placeholder figures.
- Whether names in output need anonymization before presenting.

## Dropped

- Generated CODEOWNERS (user decision).
- Interactive ownership network with BlitZoom (user decision).
- Public-code "go global" runs (World of Code scale): out of scope.
