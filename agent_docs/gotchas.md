# Gotchas and findings

## Contents
- Traps
- Findings

## Traps

- **Making the algorithm smarter kills the joke.** Context hashing, similarity
  fallback, or ignoring trivial lines are what a real tool would do (see
  [research.md](research.md)). Here they hide the absurdities. Any such option
  must be off by default.
- **Don't add normalization.** Trimming, whitespace folding, or CRLF stripping
  was considered and rejected by the user: a line is its exact bytes. This also
  means a repo with `core.autocrlf` history churn shows CRLF/LF flips as ownership
  transfers. That is correct output.
- **Invented numbers undercut the argument.** The pitch draft contains placeholder
  figures. Publishing them as results turns a demonstration into a made-up claim.
- **Explaining the joke in the pitch.** Disclaimers or "this is satire" lines inside
  the pitch break the deadpan. Context belongs outside the pitch (talk intro, blog
  framing), not in it.
- **Real names in output.** Leaderboards name real people as owners of `}`.
  Check with the user before publishing output from a repo with identifiable
  contributors.
- **Author identity splits.** The same person under two emails shows up as two
  owners and dilutes the top slot. Use `.mailmap` or report the raw split knowingly.
- **Cross-repo order depends on clocks.** First introducer across repos is decided
  by commit timestamps, which can be wrong, rewritten by rebase, or reset by a
  history import. Report the timestamp used so a surprising owner can be traced.
- **Repo argument order must not matter.** If ties are broken by input order,
  the same repos give different owners on different runs. Use a stable tiebreak.
- **Don't split git output with readline.** readline also breaks on a lone `\r`
  and drops the `\r` of CRLF lines, which would merge `"x\r"` into `"x"`.
  `lines()` in `src/git.js` splits on `\n` only.
- **Diff and HEAD must agree on what a line is.** Ownership is a join between
  hashes from `git log -p` and hashes from HEAD blobs. Any change to decoding,
  binary classification, or line splitting must be made on both paths, or
  HEAD lines silently become unattributed.
- **Never use our own binary check.** History learns a file is binary from git's
  "Binary files differ" line, which honors `.gitattributes`. HEAD must ask git the
  same question (`binaryPaths()` in `src/git.js`); a NUL-byte check of our own
  would disagree for attribute-marked files and leave them unattributed.
- **Unattributed lines are expected, in small numbers.** Lines written only during
  a merge resolution have no non-merge commit adding them. A large unattributed
  share means the two paths above disagree.
- **User git config can change `git log` output.** `src/git.js` pins prefixes,
  colors, signatures, notes, textconv, and relative paths. Add new overrides
  there if a config option breaks parsing.
- **Excludes must go through git pathspecs, on both paths.** `log()`, `headFiles()`,
  and `binaryPaths()` in `src/git.js` all take the same pathspecs. Filtering paths
  in JS on one side only would leave HEAD lines unattributed or let excluded
  files own lines.
- **Excludes change topo indices.** `git log` with pathspecs drops commits that
  touch only excluded files, so `commits.topo` and commit counts differ between
  runs with different exclude lists. Compare runs only with the same excludes;
  the list is stored in `runs.excludes`.
- **Old `.db` files can't take `add`.** Files built before `commits.author_name`
  existed are refused by `add` (display names need per-commit names). Rebuild
  with `index`.
- **`add` needs the original exclude list.** The check compares against the first
  run in `runs`. If `ownh.exclude` changed since the `.db` was built, pass the old
  list with `--exclude-file` or rebuild.
- **No CSS variables in the SVGs.** rsvg, Inkscape, and slide tools ignore
  `var()` and render everything black. `src/charts.js` writes plain hex in class
  rules, with dark values in a `prefers-color-scheme` block.
- **Inlined SVG styles are global in report.html.** The charts' `<style>` uses
  short class names (`.title`, `.label`, `.muted`). Page styles in `src/html.js`
  use the `r-` prefix; keep it that way or chart rules restyle the page.
- **SVG collapses leading spaces.** Line literals like `"  }"` need
  `xml:space="preserve"` on their `<text>`, or indentation, the thing that
  distinguishes the lines, disappears.
- **Git rejects tiny epoch dates.** `GIT_AUTHOR_DATE="1000 +0000"` fails with
  "invalid date format". Fixtures add `BASE_TIME` in `test/fixtures.js`.
- **`node --test test/` fails on Node 26.** A directory argument is resolved as a
  module. The npm script uses the glob `"test/*.test.js"`, which also keeps
  `fixtures.js` from being run as a test file.

## Findings

None yet. Record diagnosed bugs here as case studies.
