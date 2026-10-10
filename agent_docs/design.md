# Design: the OWNH satire

## Contents
- Goal
- Naming
- The method, as pitched
- Absurdities to surface
- Presentation
- Pitch copy

## Goal

Demonstrate the futility of code ownership as a concept by building an honest
implementation of a bad metric and presenting its output with a straight face.
The real argument, made in the final reveal: ownership is mostly an artifact of
whichever unit you chose to measure. Commit count, `git blame`, and line hash
score the same repo three ways and name three different owners (backed by [1] in
[research.md](research.md)).

## Naming

- **OWNH**, read as "Objective Weighted Normalized Heuristics". Chosen because it
  sounds like a real methodology and only reads as "own hash" once someone says it
  aloud. Introduce it as "the OWNH framework".
- Rejected alternatives, kept so they aren't re-proposed: `git blame --brace`
  (gives the joke away), OwnHash (too obvious), Hashown, Onhash, Shawno, Ownix,
  OHX Platform, 0wnh4sh, BraceBaron, `git claim`, Ownership Theater,
  Blame-as-a-Service, The } Doctrine, CODEOWNERS.min.
- Possible fake paper titles for slides: "Content-Addressable Accountability: A
  Line-Hash Approach to Code Ownership", "Who Owns }? Toward Hash-Based Software
  Stewardship", "Code Ownership Considered Hashable".

## The method, as pitched

Every line is reduced to its content hash. Ownership goes to the first
contributor in history to produce that hash. One owner per line, forever.

The tool does no normalization: whitespace, blank lines, and CRLF endings are part
of the line. The pitch still calls the hash "normalized" and the N in OWNH still
stands for Normalized. The gap reads as part of the joke; ask the user before
changing either side.

## Absurdities to surface

Each should appear in real output, not only in prose. Check which ones a given
repo actually exhibits.

- **The Brace Baron.** Whoever first committed a lone `}` owns every closing brace.
  Same for blank lines, `else {`, `*/`.
- **Language idioms.** In Go, `if err != nil {` makes one engineer the owner of
  every error path.
- **Whitespace takeover.** A trailing space or tabs-to-spaces is a hostile
  takeover. Running a formatter hands the codebase to the formatter commit's author.
- **The Brace Baron is per indentation level.** `}`, `  }`, and `    }` are three
  lines with three owners. Same for blank lines versus CRLF blank lines (`"\r"`):
  Windows contributors own their own whitespace.
- **Rename coup.** `userId` to `userID` transfers every touched line to whoever
  ran the find-and-replace.
- **Hostile revert.** Reverting restores old hashes, so ownership snaps back to the
  original author, possibly long gone.
- **Go global.** Hashing across public code (World of Code style) gives
  `import React from 'react'` to someone at Meta and license headers to whoever
  first pasted the Apache boilerplate.
- **Bus factor of one.** "If Dave leaves, nobody will be able to close a scope."
- **Inheritance by copy-paste.** Pasting a Stack Overflow answer makes its poster a
  stakeholder in your payment service.

## Presentation

- Ownership leaderboard where #1 is "Initial import" and #2 set up the linter.
- Pie chart "Ownership by line hash" with `}` as the largest slice.
- Cross-repository ownership heatmap: most repos are largely "owned" from the largest one.
- Spider charts, because every manager loves spider charts. The owner profile
  is "Normalized" (to the highest value shown), which finally gives the N in
  OWNH something to do.
- An "Oddities" section that states the absurd findings flatly.
- Punchline slide: the three-way comparison (commits / blame / hash).
- Deliver deadpan under the OWNH name, then reveal the leaderboard.

## Pitch site

`docs/index.html` is a static, self-contained landing page, live at
https://ownh.org (GitHub Pages from `docs/`; `docs/CNAME` holds the domain). It
links to the repo, https://github.com/wistrand/ownh. It is in the deadpan
corporate voice (user decision: pitch only, no data from real runs). It uses no
figures from runs, no customer logos, and no testimonials. Code-panel hashes are
real SHA-256 prefixes (`e3b0` for an empty line, `d10b` for `}`, `737d` for
`  }`). The research section paraphrases [research.md](research.md) and links each
claim to its source; keep it accurate if that changes.

- `docs/sample/` is a real report of six generated demonstration repositories
  (`scripts/demo-repos.js`, fictional authors, seeded history), built by
  `npm run sample`. Its AI sections come from `docs/sample/ai-cache.json`
  (rebuilds reuse them without a key; `node scripts/build-sample.js --ai` after
  data changes). It is the one place the site shows
  tool output; regenerate it whenever report output changes, never edit it.
- `docs/ownh-whitepaper.pdf` is the method whitepaper ("Content-Addressable
  Accountability"), built from `whitepaper/ownh-whitepaper.tex` by
  `npm run whitepaper` (pdflatex; byte-identical rebuilds via `EDITION` in
  `scripts/build-whitepaper.js` and `\pdftrailerid{}`). Linked from the site
  nav, the method section (download button), and the closing section. User
  decisions on scope and style:
  - Core definitions and methods only: definitions, attribution, properties,
    the three-way benchmark, leverage, demolition, survival, outlook.
  - No figures from runs.
  - No implementation details (storage, report formats, excludes, adding
    repos, blame sampling, history-walk flags, ranking thresholds).
  - No archetypes, profiles, oddities, or AI prose.
  - Method text in the passive voice, never "OWNH does X".
  - Every statement must match `src/`: update it when the definitions,
    attribution, or metrics change. Same deadpan voice and citation rule as
    the site.
- `docs/og.png` is the link-preview image (Open Graph and Twitter tags in the
  page head), rendered from `scripts/og.svg` with `rsvg-convert`.
- The OKR section's figures (KR sample lines and the KPI table) are copied by
  hand from `docs/sample/report.json`. After every `npm run sample`, check
  them against `timeline.kpis`, `timeline.projections.blank`, and
  `survival.all`; they drifted once already.
- FAQ entries riff on real tools (`--ignore-revs-file`, truck factor), see the
  Similar systems section of [research.md](research.md).

## Pitch copy

Draft deadpan pitch. Corporate voice is intentional here and only here. The
"14%" and "2014" figures are placeholders; replace them with real run output
before use (see the invariants in CLAUDE.md).

> **Introducing OWNH: Objective Weighted Normalized Heuristics**
>
> Ownership, solved. Mathematically.
>
> For decades, engineering organizations have relied on subjective, political,
> and frankly emotional methods to decide who owns code. Commit counts can be
> gamed. Git blame only remembers the last person who touched a line. CODEOWNERS
> files are fiction maintained by whoever lost the meeting.
>
> OWNH removes the human element entirely.
>
> **How it works.** Every line of code is reduced to its normalized content hash.
> Ownership goes to the first contributor in history to produce that hash. No
> interviews, no context, no feelings. Just cryptographic truth.
>
> **Key benefits**
> - Unambiguous accountability. Every line has exactly one owner, forever,
>   regardless of who maintains it today.
> - Organization-wide insight. OWNH surfaces hidden contributors your org chart
>   missed. In pilot deployments, the top owner was frequently someone with no
>   recent commits, sometimes someone who had left the company.
> - Refactor-aware governance. Changing a line changes its hash, which changes its
>   owner. Ownership flows naturally to whoever touched it first, exactly as it
>   should.
> - Formatter-aware. Every formatting commit is recognized as the contribution
>   it is. Run Prettier and see your ownership consolidate.
> - Cross-repository synergy. Identical lines across services share one owner, so
>   a single trusted engineer can be responsible for thousands of closing braces.
>
> **Early results.** In our internal pilot, OWNH identified a single principal
> stakeholder for [PLACEHOLDER 14%] of the codebase. Their contribution, a lone
> `}` committed in [PLACEHOLDER 2014], remains foundational to every module we ship.
>
> OWNH: because someone has to own it.

Note: the pitch has no winks. An earlier "Formatter-agnostic. Just kidding." was
replaced with the deadpan "Formatter-aware" line (user decision); keep it that
way.
