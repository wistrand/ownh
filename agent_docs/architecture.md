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
- Agent
- Sample report and site
- Decisions
- Verification
- Performance
- Open questions
- Dropped

## Overview

```
repos ──> index ──────> .db (SQLite) ──> blame (optional) ──> .db
                              │
                              └──> collectStats ──> summary (text)
                                                └──> report: report.html, leaderboard.md, SVG, JSON, CSV
```

One `.db` per analysis is the reproducible artifact behind every number:
reports are derived from it and regenerated, never edited. Runtime is Node.js
(>= 22.13, for unflagged `node:sqlite`; inferred, not verified) with no npm
dependencies. Git does all repository work through subprocesses (`src/git.js`).

**Key files**: `bin/ownh.js` (CLI), `src/indexer.js` (`index`, `add` for appending,
`indexHistory`, `indexHead`), `src/git.js` (`log`, `blame`, `catBlobs`,
`headFiles`, `binaryPaths`, `blameClone`), `src/db.js` (`SCHEMA`),
`src/stats.js` (`collectStats`), `src/report.js` (`report`).

## Commands

Without `--db`, every command uses `./ownh.db` (`dbFrom` in `bin/ownh.js`) and
logs `using ./ownh.db` to stderr, so a run in the wrong directory shows it.
Only `index` may create it; the others fail when it is missing.

| Command   | Does                                                                                            |
|-----------|-------------------------------------------------------------------------------------------------|
| `index`   | New `.db` built in a temp file, renamed on success; `--force` replaces a `.db`                  |
|           | (stale `-journal`/`-wal`/`-shm` of the old `.db` are removed first).                            |
|           | Existing `.db`: appends the repos in one transaction, same result as indexing all at once.      |
|           | Refuses a repo already present, listing every repo `--force` must be given.                     |
|           | `add` is a hidden alias that never creates a `.db` and takes no `--force`.                      |
| `blame`   | Fills per-line blame authors; slow, parallel, resumable, optional `--sample N`.                 |
| `summary` | Plain-text summary to stdout.                                                                   |
| `report`  | Report files into `--out`, default `report/<db name>/`; stats cached there (`--no-cache`).      |
|           | `--pseudonymize`: names replaced, default out `report/<db name>-pseudonymized/` (see Reports).  |
| `agent`   | Terminal Q&A over one `.db` through tool calls (see Agent); same AI settings as `--ai`.         |
| `update`  | `git pull --ff-only` in the checkout the command runs from, if it is its own repository root.   |
| `info`    | Version, the command path and the file it resolves to, source checkout, git commit, Node.       |

A repo path may point anywhere inside the repo (a subdirectory, its `.git`
directory); `repoRoot` resolves it to the work-tree root, or the git directory
of a bare repo, so the name and the pathspecs do not depend on how it was typed.

Excludes: `--exclude-file` (repeatable), `--no-excludes`, or the optional,
git-ignored `ownh.exclude` next to the tool (missing is fine; an explicit
missing file is an error). Patterns become git exclude pathspecs
(`toPathspecs` in `src/exclude.js`), applied identically to history and HEAD.
Appending uses the `.db`'s stored list unless exclude flags are given, and
refuses an explicit list that differs.

All long commands report progress on stderr every 5 seconds.

## Indexing (history walk)

`indexHistory` in `src/indexer.js` reads `log()` from `src/git.js`:
`git log --reverse --topo-order --full-history --diff-merges=remerge -p -M
--full-index --unified=0 --diff-algorithm=myers` plus pinned output options.
`CONFIG` in `src/git.js` pins the user config that changes which lines a diff
reports (rename limits, merge rename handling for remerge, the indent
heuristic), the order of files in a diff (`diff.orderFile=/dev/null`, an empty
order file, since an empty value is an error), and the output encoding of
names, to git's defaults.

- **Raw bytes.** The walk output is read as byte strings (`BYTES`: Node's
  `latin1`, used only as a lossless byte-to-char round trip) and lines are hashed
  as those bytes, so lines in any encoding, valid UTF-8 or not, keep distinct
  hashes. Names and emails are decoded as UTF-8 (`utf8()`); paths, in history
  and at HEAD alike, with `pathText()`, which keeps bytes that are not valid
  UTF-8 as `\xNN` so two such names stay distinct; C-quoted names are unquoted
  as bytes first (`unquote` in `src/indexer.js`). The stored
  display `text` is UTF-8 decoded too. Valid UTF-8 lines hash as before.
- **Ownership rule.** Every added line is hashed exactly as written (SHA-256,
  `src/hash.js`; no normalization) and upserted into `line_hashes`, keeping the
  smallest key `(author_time, repo name, topo)` (`UPSERT_HASH`). The owner is the
  author of the commit holding that key. Taking the minimum gives the same answer
  as one merged timeline, whatever order repos and commits are processed in,
  which is what makes appending equal to a full `index`.
- **Merges.** Diffed with remerge: git redoes the automatic merge and diffs it
  against the recorded result, so a merge's added lines are what its author
  wrote by hand (conflict resolutions, new code). Taking one side unchanged adds
  nothing. Merges are stored with `commits.is_merge = 1` and excluded from commit
  counts (totals, the commits method); their removals are not recorded. They
  count as activity: contributor checks, inactivity, and "now" include them,
  since a merge's author can own lines through it.
- **Binary files.** Git decides what is binary ("Binary files differ"). The
  diff carries only blob ids (`--full-index`); blobs are read afterwards with
  `cat-file --batch`. git prints "Binary files differ" when either side is
  binary, so each side is classified on its own, as HEAD scoring would:
  gitattributes for its path (`attrBinary`: `-diff`, or a diff driver whose
  config sets `diff.<driver>.binary`) or git's content check (a NUL in the
  first 8000 bytes, `looksBinary`). A binary side is one line, hashed whole; a
  text side contributes its lines (a file rewritten from binary to text gets
  owned lines, and text rewritten as binary counts its lines as removed).
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
  skipped, added or deleted. Paths come from `rename from/to`, `--- a/`,
  `+++ b/` (git's trailing tab after names with spaces is dropped), or the
  `diff --git` header when both sides are the same path. Every git stream is killed if its reader stops early (`run()` and
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
| `runs`        | tool version, exclude patterns, start and finish time per `index` run (appends included)        |
| `repos`       | name (directory basename, unique), path, stored head                                            |
| `identities`  | lowercased email, display name                                                                  |
| `commits`     | repo, sha, topo, author time, identity, author name, `added_lines`, `added_blank`, `is_merge`   |
| `line_hashes` | hash, binary flag, text (NULL for binary), first-introducer key, owning commit, path            |
| `head_lines`  | repo, path, line number, hash, blame author                                                     |
| `churn`       | hash, repo, quarter, author, lines added, lines removed                                         |
| `blame_files` | files whose blame is stored (created by `blame`)                                                |
| `blame_repos` | per repo: blame sample size, or NULL for full (created by `blame`)                              |

Older databases missing `churn` or the newer `commits` columns still report
(features degrade), but appending refuses them: rebuild with `index --force`.

## Blame

`src/blame.js`. Fills `head_lines.blame_identity_id` from `git blame --porcelain`
at each repo's stored head, in parallel (`--jobs`, default CPU count).

- Runs in a throwaway bare `--shared` clone with a commit-graph and changed-path
  Bloom filters for the stored head (`blameClone`); about 6x faster on a
  very large repo, and the user's repos are not modified. `.mailmap` comes from
  the head via `mailmap.blob`.
- Refuses a missing `.db` (rather than creating an empty one) or one without a
  completed index run.
- Identities only blame knows (an email the history walk never saw) are named
  with the smallest name blame reports for them, so the name does not depend
  on which parallel job finished first.
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
- **Ownership entropy** (`entropy` in `src/stats.js`, `methods.entropy`): per
  method, per repo and overall, the Shannon entropy in bits of the shares that
  method gives each owner, plus `effectiveOwners` (2^bits). Unowned lines are
  left out; bots count. Blame uses the exact counts, or the sample's expanded
  estimate; overall blame entropy needs blame for every repo, like the overall
  top owner. Computed in the combining code from counts the stages already
  return. Shown as a report tile and in the Markdown header (line hash),
  `methods.csv` columns, the `summary` header, the agent's `overview`, and the
  AI facts (`ownershipEntropyBits`: bits to one decimal only, since the
  effective owner count is close to a head count). A per-method table was
  tried and dropped as too much (user decision). Source: author entropy in
  [research.md](research.md).
- **Line entropy** (`lineEntropy` stage, `src/lineentropy.js`;
  `owners[].lineEntropy`): per owner, the entropy in bits of their HEAD lines
  over the distinct lines they own: 0 when every line is a copy of one line.
  The principal owner of blank lines and braces scores low. Counted per hash
  in 16 ranges and summed per owner (H = log2 N - sum(n log2 n) / N), so no
  per-owner hash list is held; about 4 s on 3.5 million lines. Shown as a
  column in the principal owners table (distinct lines in the HTML tooltip)
  and in `owners.csv`. Named apart from ownership entropy on purpose: one
  measures people, the other one person's lines.
- **Timeline** (`src/timeline.js`, `buildTimeline`): quarterly series. With
  `churn` it is a true history (net added minus removed per owner, checked
  against the HEAD line count); without it, surviving lines by first-written
  quarter. Projections take the least-squares slope of the last 12 quarters,
  continue it from the latest value, and report R². "Now" is the newest commit's
  quarter, not the clock.
- **Churn analyses** (`src/churn.js`): deletions (who removes whose lines, the
  most-removed line, lines re-added after deletion) and survival. Rankings break
  ties by email, never identity id. Every owner also gets `removedOthers` (lines
  of others removed), which the net-demolisher archetype tests; the top-10
  lists are for display only. Survival pairs removals with the oldest copies of
  a line first, within each repository (copies are indistinguishable; a removal
  in one repo never ends a copy in another), then computes per-owner Kaplan-Meier curves and half-lives,
  extrapolated exponentially when the curve never reaches 50%.
- **Leverage**: lines owned per line written (`commits.added_lines`).
- **Declared ownership** (`declaredOwnership` in `src/codeowners.js`): the
  CODEOWNERS file at each repo's stored head (`.github/`, root, `docs/`,
  `.gitlab/`, first found), parsed with GitHub's rules (last match wins,
  gitignore-like globs, a wildcard last segment stays at its level, a rule
  with no owners leaves paths unowned). Every line at head is resolved to its
  rule (once per path); per rule: declared owners, lines, top owner by line
  hash, and by blame for fully blamed repos only. Owners are teams or users,
  not identities, so there is no agree flag. The file is read with git at
  report time from the stored head; the stage key includes its blob id
  (`codeownersFingerprint`, or "unreadable" when the clone is gone), so a
  clone that comes back is read again. Rules that decide no line are split
  into "matches no file" (tested against every file in the tree, `git ls-tree`,
  not only files with lines) and "overridden by later rules". Per-rule blame
  shares are of blamed lines. Repos where one rule decides every line share a
  compact table. About 50 s for an 826-rule file over 11.7M lines.
  Patterns and team names are paths and names: never in the AI facts.
  Reading CODEOWNERS is not the dropped "generate CODEOWNERS" feature.

## Reports

`report()` in `src/report.js` writes into `report/<db name>/` by default. Every report names
its database and generation time (UTC) in the header and in `report.json`
(`generated`); `SOURCE_DATE_EPOCH` overrides the clock for reproducible output.
The HTML `<title>` starts with the database name, and "OWNH" in the header of
`report.html` and `leaderboard.md` links to https://ownh.org (`SITE` in
`src/stats.js`). Counts in prose go through `plural` and `repoCount`
(`src/stats.js`), so a single repository reads "1 repository".
The owner-status pie (`ownerStatus` in `src/archetypes.js`) puts bots in
their own slice and divides by all lines at HEAD; the inactive archetype and
the Outlook's inactive-owner series count an idle bot as inactive, and the
series divides by owned lines. The three inactive figures can differ
slightly; all use `ACTIVE_WINDOW` from `src/quarters.js`.

| File                                         | Content                                                                    |
|----------------------------------------------|----------------------------------------------------------------------------|
| `report.html`                                | self-contained page; inline SVG charts, sortable tables, section anchors   |
| `leaderboard.md`                             | the same content in Markdown                                               |
| `report.json`                                | the full stats object                                                      |
| `owners.csv`, `lines.csv`                    | data tables                                                                |
| `cross-ownership.csv`, `methods.csv`         | data tables                                                                |
| `codeowners.csv`                             | declared ownership per CODEOWNERS rule (only when a repo has one)          |
| `owner-shares.svg`                           | bars, top 10 owners' share of all lines plus everyone else                 |
| `owner-composition.svg`                      | top 8 owners' lines by kind: code, blank, punctuation only, binary         |
| `ownership-by-line-hash.svg`                 | pie, top 5 lines plus everything else (never more than 6 segments)         |
| `owner-status.svg`                           | pie, lines by owner status: active, inactive, automation, no owner         |
| `cross-ownership.svg`                        | repo x origin-repo heatmap                                                 |
| `owner-profile.svg`, `repo-profile.svg`      | radar charts, at most 3 series                                             |
| `ownership-outlook.svg`                      | ownership outlook trend chart                                              |
| `blank-line-outlook.svg`                     | blank-line outlook trend chart                                             |
| `code-survival.svg`                          | survival curves                                                            |
| `stats-cache.json`                           | cached `collectStats` stages, one key each (see below; not a report file)  |
| `ai-request.json`, `ai-cache.json`           | the AI request as sent, and the cached answer (with `--ai`)                |
| `agent-requests.jsonl`                       | every request `ownh agent` sent, appended per session                      |

Section order (user decision): AI insights (with `--ai`), tiles (HTML),
principal owners, ownership profiles, principal lines, code survival, outlook,
OKR draft (with `--ai`), ownership archetypes, cross-repository ownership,
material findings, three ways to own, declared ownership (repos with
CODEOWNERS), leverage, code demolition, repositories, excluded patterns.

"Material findings" is the user-facing name of the oddities (`src/oddities.js`,
`stats.oddities`; renamed and moved to the top, user decision): grouped by
`groupFindings` into Line holdings, Repository control, Contributor
performance, Measurement consistency, and Declared ownership compliance (a
kind not mapped in `CATEGORIES` lands under Other), numbered across groups,
under a one-line deadpan note (`FINDINGS_NOTE`), with a tile counting them in
`report.html`. The agent's `material_findings` tool returns the same numbers
and categories. The code keeps the internal name.

- Untrusted text (author names, repository names, line text, AI prose) is
  escaped: `md()` in `src/report.js` for Markdown (inline markup, HTML
  characters, leading block markers), `esc()` in `src/charts.js` for HTML and
  SVG (which also replaces XML-invalid characters, so the standalone SVGs stay
  well-formed). Code spans use a fence longer than any backtick run inside.
  Repository section ids are made unique (`repoAnchors` in `src/html.js`).

- Charts (`src/charts.js`) use plain hex colors in class rules with a dark-mode
  media block, never CSS variables, so rsvg and slide tools render them.
- "Now" is the newest commit's quarter. When the report is generated inside
  that quarter (generation time, `SOURCE_DATE_EPOCH` if set), `report()` sets
  `timeline.inProgress`: the KPI row reads "(in progress)" (`kpiQuarter` in
  `src/outlook.js`), the outlook note says so, and the AI facts mark that
  quarter. Without the mark, a quarter ten days old read as "0% growth, off
  track". Projections still include the partial quarter in their fit.
- Outlook statements and charts are shared by Markdown and HTML
  (`src/outlook.js`); leverage, demolition, and survival pieces likewise
  (`src/sections.js`); radar data in `src/profiles.js`.
- Oddities (`src/oddities.js`) are facts derived from the stats; each claim is
  checked by the code that prints it. Automation is `isBot`: known tools,
  `[bot]` accounts, and names with "bot", "robot", or "automation" as a word.
  `bot-line-entropy` fires when, among the top 10 owners, the highest line
  entropy belongs to automation (the bot holds the most varied lines while the
  principal owner holds the copies).
- Line kinds (`KIND` in `src/head.js`: code, blank, punctuation only, binary):
  each `head` row carries a kind; `collectStats` sums them into
  `owners[].composition` and per repository into `repos[].owners[].composition`.
  Both come from the cached `head` stage, so adding a breakdown needs no new
  stage.
- Stats cache (`cachedStats` in `src/report.js`, `src/stagecache.js`):
  `collectStats` is nearly all of a report's run time. Its expensive passes are
  stages, each cached in `stats-cache.json` in the report directory under its
  own key; the rest of `collectStats` only combines their results and always
  runs.

  | Stage         | Module            | Data key            | Args             |
  |---------------|-------------------|---------------------|------------------|
  | `head`        | `head.js`         | index runs          |                  |
  | `lines`       | `head.js`         | index runs          | `--top`          |
  | `lineEntropy` | `lineentropy.js`  | index runs          |                  |
  | `blame`       | `blamecounts.js`  | index runs, blame   |                  |
  | `declared`    | `codeowners.js`   | index runs, blame   |                  |
  | `history`     | `churn.js`        | index runs          |                  |
  | `deletions`   | `churn.js`        | index runs          |                  |
  | `survival`    | `churn.js`        | index runs          | top owners, now  |

  The code key is `codeHash` of the stage's module: its source plus, followed
  through its import and re-export statements, every local module it uses,
  computed when `stats.js` loads, so it describes the running code. Index runs
  are the completed `runs` rows (every `index` run, appends included); blame is the
  `blame_files` count and `blame_repos` settings. A `blame` run recomputes only
  `blame` and `declared`; editing `churn.js` recomputes only the churn stages;
  editing `stats.js` (the combining code) recomputes nothing. Stage values are
  plain JSON (identity ids or identity objects, never Maps) and pass through
  JSON fresh or cached, so both render the same. Each computed stage is
  written to the file at once (temp file, then rename), so a stopped report
  keeps the stages it finished. `--no-cache` neither reads
  nor writes the file; the sample build never caches.
- Pseudonymized reports (`--pseudonymize`, `pseudonymizeStats` in
  `src/pseudonymize.js`): the stats are rewritten once, after `cachedStats` and
  before oddities, archetypes, AI prose, and every renderer, so all files agree.
  - Every `{ name, email }` object is an identity (no other stats object has
    exactly those two keys); each is replaced by email with "Contributor N",
    numbered by rank in `owners`, then by first appearance in the stats.
  - Bots (`isBot`) keep their names: the bot oddities and the automation
    archetype read them. Their email is replaced too (`automation-N@...`)
    unless it is itself an automation address (`isBotEmail`): a bot-like name
    can sit on a person's email, and "Bot" is also a surname.
  - All other strings are scrubbed, in any case, of committer emails, of
    every multi-word name an email committed under (`commits.author_name`,
    read by `commitNames` in `src/report.js`), and of CODEOWNERS handles.
    One-word names are left (they are ordinary words as often), as are names
    that never committed, such as copyright holders in line text. The words
    are split into regexes of 2,000 alternatives: V8 refuses one regex with
    tens of thousands.
  - CODEOWNERS handles (`owners` string arrays) become `@user-N`, `@team-N`,
    or `user-N@example.invalid`.
  - Oddities about two people sharing a name disappear, since pseudonyms are
    per email.
  - The stage cache holds real names, so the CLI keeps it in the plain report
    directory (`cacheDir`) and writes the pseudonymized files next to it;
    `report()` refuses a pseudonymized run whose output directory is the
    cache directory. Every run also deletes report files it did not write
    this time (`REPORT_FILES`), so a plain report's files cannot linger under
    a pseudonymized one.
    `ai-cache.json` and `ai-request.json` hold tokens only and go to the
    output directory; AI text is unmapped to the pseudonyms.
  - `summary` and `ownh agent` are not pseudonymized.
- Two rules keep the cache safe. A stage may depend only on code its module
  imports: pass data into a stage, never a function from another module (that
  is why `codeowners.js` imports `topOf` from `rank.js` instead of taking it as
  an argument). A stage may read only data its key covers: a stage that starts
  reading another table needs that table in its data key.

## AI prose

`src/ai.js`, enabled with `report --ai` (user request, opt-in). Writes three
things with any OpenAI-compatible chat completions API, hosted or local (OpenRouter by default): an executive
summary (top of the report), an OKR draft (after the Outlook), and names for
the owner archetypes. Archetype membership is rule-based (`src/archetypes.js`)
and always shown; the AI only names the groups.

- **Configuration:** `OWNH_AI_KEY` or `OPENROUTER_API_KEY`; optional
  `OWNH_AI_MODEL` (default `openai/gpt-6-luna`, user decision, `DEFAULT_MODEL`)
  and `OWNH_AI_BASE_URL` (default OpenRouter). A key is required only for the
  default endpoint (`requireKey`); with a custom base URL and no key, requests
  go out without an authorization header, so keyless local servers
  (OpenAI-compatible `/chat/completions`) work. Missing settings withhold the
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
  - Sizes are bands ("tens of millions" of lines; repositories and owners as "fewer than ten", "ten to two dozen" (10 to 24), "dozens", "hundreds"). A single repository is "one", its methods agree in "the repository" or "no repository", and `crossRepository` is left out (nothing to compare), so the model does not describe it as a portfolio.
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
    `scripts/check-ai-payload.js <db>` checks that file for committer
    names, emails, repository names, and years, and exits 1 on a hit, so it
    can gate the real run. It skips the system prompt (fixed text) and
    matches one-word names and repository names only as whole JSON values,
    since committers and repositories can be named by ordinary words the
    prompt and the size bands use (a committer called "two" would match "ten
    to two dozen"). It also refuses a request file more than an hour old;
    pass the report directory for `--out` or `--pseudonymize` runs.
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

## Agent

`bin/ownh.js agent --db x.db` (`src/agent.js`, `runAgent`) is a terminal session
for questions about one database. It loads stats through `cachedStats` with
the report directory's cache, so a reported database starts in seconds, and
uses the `--ai` settings (`aiConfig`: endpoint, key, model, ZDR, temperature).

- **Tools.** The model answers through OpenAI-style function calling
  (`chatMessage` in `src/ai.js`, `tools`), at most 8 rounds per question. The
  tools are read-only views of the stats (`agentTools`): overview, owners
  (overall or per repo, ranked by lines owned or by kind of line,
  `rank_by`), owner profile, repositories, top lines, outlook (with the
  head-line total and why the history series differs from it), deletions,
  survival, CODEOWNERS, archetypes, leverage ranking, and the report's
  material findings (`material_findings`; their text with names replaced as in questions, quoted lines and
  paths as tokens). A question the tools cannot answer directly makes the
  model fan out many calls (it once called owner_profile 18 times to rank
  leverage): add a tool rather than relying on that. No SQL from the model (user
  decision: curated tools).
- **Finding names.** The `find` tool resolves a person or repository the
  model has no token for, locally and per query (no prebuilt index): exact
  name, whole word, part of a word, then the closest typos (one edit, two
  from six letters on), with case and accents ignored; a phrase that matches
  nothing whole is tried word by word ("the analyzer"). It returns tokens with
  lines and commits, never names. The question filter also replaces a word of
  four or more letters that is a whole word of one person's multi-word name
  ("lindqvist"; one person may be several identities under the same name, and
  then gets all their tokens), unless it is a word of a repository name or of
  the agent's own vocabulary (words of its prompt and tool descriptions, so
  "line hash" keeps "hash" even when someone is named Hash). Words are runs of
  letters, so "lindqvist's" and "lindqvist-style" match, and a leading "@"
  never protects a name ("@Mark"). Partial repository names are sent as typed
  (user decision).
- **Change over time.** `ownership_change` (optional quarter range and repo):
  who gained and lost owned lines (added minus removed, per owner of the
  lines) and who removed the most lines owned by others. The prompt sends
  "took over", "gained", "lost" questions there, defaulting to the last four
  quarters, instead of answering with current holdings.
- **Launch.** On a terminal: the logo, one progress line while stats load
  (cached stages are not listed), the database summary, a green "Ready." line,
  and a bold colored `ownh>` prompt. Piped sessions get plain text only.
  Colors respect `NO_COLOR` (any non-empty value turns them off, `useColor`);
  the progress line still redraws in place, which is cursor control, not color.
- **Time.** The system prompt carries today's date and quarter. Two tools
  query the database directly over a read-only connection: `removals` for a
  range of quarters (the churn table is per quarter, so "last month" becomes
  the quarter that contains it, and the answer says so; a full scan of churn,
  about 1 s per 4 GB of database) and `activity` between two dates (commits
  have exact author times; merges excluded). Finer removal periods would need
  churn recorded per month, which means a re-index.
- **Privacy** (user decision: pseudonymized). Tool results carry tokens for
  owners `[O#]`, repositories `[R#]`, paths and patterns `[F#]`, lines `[L#]`,
  and CODEOWNERS handles `[D#]`; emails and line text are never sent. The
  report's oddities are built with these tokens through `findOddities`'
  naming adapter, never by rewriting its finished prose. The user's question
  is filtered against every identity and every name an author committed under
  (`peopleOf`), longest first, whole words: emails and multi-word names in any
  case, one-word names in exact case only (so "Mark" the word survives),
  repository names with a non-letter in any case, and repositories named by
  an ordinary word ("docs", say) only in backticks or quotes or next to
  "repo"; paths, CODEOWNERS patterns, and handles that appear in the stats
  become their tokens too (a path the stats do not know is sent as typed).
  A lowercase one-word name that is also a word of the agent's prompt ("or")
  is left alone; other short names ("ff") are replaced.
  The session shows "sent as" when anything changed, and tokens in
  answers are mapped back locally. A name
  several owners share (one author, several emails) becomes all their tokens
  in a question ("[O1] or [O2]"), and such owners are shown with their email in
  answers; emails still never reach the model.
  Counts, percentages, and quarter labels are sent as they are. Every request
  body is appended to `agent-requests.jsonl` in the report directory.
- **Voice.** The system prompt makes the agent speak for OWNH, deadpan like
  the site: ownership stated as fact, conclusion first ("Nothing changes in
  ownership: ..."), no hedging, and never a disclaimer about the method ("a
  proxy", "an artifact") or a suggestion of a better measure. Numbers still
  come only from the tools. Without this it explained the joke. Rules of the
  method (ownership is permanent) are given as background, not as wording:
  phrased as "say so", the model ended every answer with the same sentence.
- **Session.** Works on a terminal and on piped input (one question per
  line). `/clear` forgets the conversation, `/quit` leaves; a failed request
  rolls the conversation back to before the question. Answers are plain text.

## Sample report and site

- `docs/index.html` is the hand-written pitch site (see [design.md](design.md)).
- `docs/sample/` is a real report of fictional data: `scripts/demo-repos.js`
  builds six repositories with about forty fictional authors over five and a
  half years from a seeded generator with fixed dates (founder import, copied
  services, shared headers, a formatter commit, a dependency bot, departures,
  rewrites, reverts, conflict merges, and a late CODEOWNERS file per repo,
  committed after the seeded history so it does not shift it). `npm run sample` rebuilds it; output is
  byte-identical across runs except the generation time.
- `scripts/screenshot.mjs` captures pages after scripted content has rendered
  (headless Firefox over WebDriver BiDi).
- `docs/ownh-whitepaper.pdf` is built from `whitepaper/ownh-whitepaper.tex` by
  `scripts/build-whitepaper.js` (`npm run whitepaper`, pdflatex, byte-identical
  rebuilds). It states the core definitions and methods only; see
  [design.md](design.md) for what it leaves out.

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
| Reruns           | `index` appends new repos, `--force` rebuilds; updating a repo in place is not supported.                                                                                                                         |
| Display names    | Most-used name per email across the `.db` (user decision).                                                                                                                                                        |
| Line encoding    | Raw bytes on both paths (`BYTES`), never decoded before hashing; only names, paths, and display text are UTF-8 decoded.                                                                                           |
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
  independence, `--force`, excludes and pathspecs, appending equal to `index`,
  display names, report/summary agreement, the three methods, blame sampling,
  history simplification, shallow clones, stream cleanup, large blobs,
  oddities, timeline math, and merge-resolution ownership.
- Charts are checked by eye: `rsvg-convert` for SVG files, `scripts/screenshot.mjs`
  for pages.
- History reconciliation: the Outlook note prints net added-minus-removed lines
  against the HEAD line count.

## Performance

Measured on real runs (repositories not named, see CLAUDE.md conventions):

- Index: about 12 minutes for a very large repo (hundreds of thousands of commits, 11.7M lines) before churn was
  recorded; churn adds a noticeable but unmeasured share. Small repos take seconds.
- Database: about 450 bytes per HEAD line before churn; churn added about 20% on
  a 4M-line database and about 40% on the largest database (14.6 GB to 20.4 GB).
- Blame with commit-graph: about 40 files per second on 16 cores for the large
  repo (about 20 minutes for 57k files).
- Report: about 1.5 minutes for 15M HEAD lines before churn, dominated by the
  per-line owner join of the largest repo; about 7 minutes on the largest
  database with the churn analyses. A rerun with an unchanged database and
  statistics code reuses `stats-cache.json` and takes seconds.
- Remerge walking costs nothing measurable, including on a repo with 4,200 merges.

## Open questions

- Refreshing repos already in a `.db` (new commits since the stored head):
  feasible with the same min-key upsert plus replacing that repo's
  `head_lines` and churn. Not built.
- Which generated or vendored files belong in an exclude list beyond `dist/`.
  In real runs a single generated data file was about half of all HEAD lines.
- `.db` size: hashes as 32-byte BLOBs and interned paths would shrink it.
- Lines "re-added after deletion" are counted per quarter, so common lines
  (blanks, braces) dominate the figure; it overstates actual reverts.
- Pitch copy in [design.md](design.md) still has placeholder figures.
- `summary` and `ownh agent` show real names; only `report --pseudonymize` replaces them.

## Dropped

- Generated CODEOWNERS (user decision).
- Interactive ownership network with BlitZoom (user decision).
- Public-code "go global" runs (World of Code scale): out of scope.
- Deletion hazard by age (Nelson-Aalen / per-age `d / atRisk` from
  `kaplanMeier()`) as a "Deletion risk by age" chart (user decision, after a
  check). The per-age rate depends on how removals are paired with copies of a
  hash: `survival()` takes the oldest copy first. Recomputing with newest-first
  pairing on a 16-repo public set and on the largest local database: 44% and
  54% of deaths came from hashes with live copies from more than one quarter,
  so the convention decides the age of about half of all deaths. The age-0
  rate doubled between conventions and later bands moved by up to 3x. Only
  "the first year is the riskiest" held in both databases under both
  conventions. On the larger database the rate also rose again at 7 to 10
  years under both, most likely from a few large deletions of old code, so a
  chart would present the pairing convention and deletion events as a
  property of code age. Related: the projected half-life assumes a constant
  rate, which the check shows does not hold; it stays labeled as projected.
