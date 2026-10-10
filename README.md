# OWNH

The OWNH framework: Objective Weighted Normalized Heuristics for code ownership.

Ownership, solved. Mathematically. OWNH reduces every line of code to its
exact content hash and assigns it to the first contributor in history to
produce that hash, across every repository you give it. No interviews, no
context, no feelings.

Website: [ownh.org](https://ownh.org)

## Status

Working: indexing, adding repositories, the text summary, HTML/Markdown/SVG/
JSON/CSV reports, and a comparison against commit counts and `git blame`.

## Quick start

Requires Node.js 22.13 or later and git. No dependencies.

```bash
bin/ownh.js index --db acme.db ~/src/frontend ~/src/backend
bin/ownh.js summary --db acme.db
```

`--force` rebuilds an existing database. To add repositories to an existing
database without rebuilding it:

```bash
bin/ownh.js add --db acme.db ~/src/another-repo
```

Files and directories listed in `ownh.exclude` (optional, not committed) are
left out, from history and from the current tree. Pass `--exclude-file <file>` (repeatable) to use your own
list instead, or `--no-excludes` to include everything.

## Reports

```bash
bin/ownh.js report --db acme.db
```

Writes into `report/acme/` (one directory per database; `--out` picks another):
`report.html` (open it in a browser), `leaderboard.md`, SVG charts (ownership
by line hash, cross-repository ownership, ownership profiles, outlook, code
survival), and the underlying data as JSON and CSV.

For comparison with conventional methods, `bin/ownh.js blame --db acme.db` runs
`git blame` on every file (slow; safe to interrupt and rerun). Add
`--sample 2000` to blame a random sample of files in large repositories and
report an estimate instead. Reports then show the top owner of each repository
by commit count, by blame, and by line hash.

### AI insights

`--ai` adds an AI-written executive summary, an OKR draft, and names for the
owner archetypes, using any OpenRouter-compatible API (default model
`openai/gpt-6-luna`; set `OWNH_AI_MODEL` to use another):

```bash
OPENROUTER_API_KEY=... bin/ownh.js report --db acme.db --ai
```

Only percentages, size bands ("tens of millions of lines"), and trends leave
the machine; every person, repository, and quarter is replaced by a token and
restored locally. On OpenRouter, requests are restricted to providers that
neither store nor train on data, and to zero-data-retention endpoints. The
exact request is saved as `ai-request.json`; `--ai-dry-run` writes it without
sending anything. Every number in the AI text is checked against OWNH's
figures, and answers are cached per database.

## Website

The site at [ownh.org](https://ownh.org) is `docs/index.html`, served by GitHub
Pages from the `docs/` folder. Its [sample report](https://ownh.org/sample/report.html)
is generated from the test repositories with `npm run sample`.

## How it works

1. Walk the combined history of all given repositories from the first commit.
2. Hash every added line exactly as written. Whitespace counts.
3. The first author to produce a hash owns it, permanently.
4. Score each repository's current tree by those owners and publish the leaderboard.

## License

Copyright 2026 Erik Wistrand. Licensed under the Apache License, Version 2.0;
see [LICENSE](LICENSE).
