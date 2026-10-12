# OWNH

The OWNH framework: Objective Weighted Normalized Heuristics for code ownership.

Ownership, solved. Mathematically. OWNH reduces every line of code to its
exact content hash and assigns it to the first contributor in history to
produce that hash, across every repository you give it. No interviews, no
context, no feelings.

Website: [ownh.org](https://ownh.org)

## Status

Working: indexing, adding repositories, the text summary, HTML/Markdown/SVG/
JSON/CSV reports, a comparison against commit counts and `git blame`, declared
ownership from CODEOWNERS, optional AI prose, and `ownh agent` for questions.

## Install

Requires Node.js 22.13 or later and git. No dependencies, no root.

```bash
curl -fsSL https://ownh.org/install.sh | sh
```

This clones OWNH into `~/.ownh` and links the `ownh` command into
`~/.local/bin` (`OWNH_HOME` and `OWNH_BIN` change both). `ownh update` (or
running the installer again) pulls the latest version;
`rm -rf ~/.ownh ~/.local/bin/ownh` removes it (`ownh info` shows the exact
paths). In a clone of this repository, `bin/ownh.js` is the same command.

## Quick start

```bash
ownh index --db acme.db ~/src/frontend ~/src/backend
ownh summary --db acme.db
```

`--db` is optional: without it, every command uses `ownh.db` in the current
directory. Running `index` again on an existing database adds the new
repositories to it, with the same result as indexing them all at once:

```bash
ownh index --db acme.db ~/src/another-repo
```

A repository already in the database is refused; `--force` rebuilds the
database from the repositories given.

Files and directories listed in `ownh.exclude` next to the tool (`~/.ownh/ownh.exclude`
after installing; optional, not committed) are
left out, from history and from the current tree. Pass `--exclude-file <file>` (repeatable) to use your own
list instead, or `--no-excludes` to include everything.

## Reports

```bash
ownh report --db acme.db
```

Writes into `report/acme/` (one directory per database; `--out` picks another):
`report.html` (open it in a browser), `leaderboard.md`, SVG charts (principal
owners and what they own, ownership by line hash and by owner status,
cross-repository ownership, ownership profiles, outlook, code survival), and
the underlying data as JSON and CSV. Every report states its Ownership
Entropy (how widely ownership is spread, in bits, with the effective number of
owners it amounts to) and each principal owner's Line Entropy (how varied the
lines they own are). Material findings, grouped by category, list the
conditions that warrant the attention of ownership leadership; the Outlook
includes the succession pipeline of emerging owners, with the owner each is
projected to overtake next.

The expensive statistics passes are cached in `stats-cache.json` in that
directory, each on its own, so a second report reruns only what the database or
code changed (a `blame` run, for example, recomputes only the blame-based parts).
`--no-cache` recomputes everything.

`--pseudonymize` writes the same report into `report/acme-pseudonymized/` with
every committer listed as "Contributor N", numbered by lines owned, and every
CODEOWNERS handle as `@user-N` or `@team-N`, for circulation beyond the
ownership committee. Automation keeps its name; its email is replaced unless it
is an automation address. Names quoted inside lines of code are replaced, in any
case, when they match a committer's email or any full name they committed under;
a one-word name or a person who never committed stays as written. The statistics
cache stays in `report/acme/`, which holds real names.

For comparison with conventional methods, `ownh blame --db acme.db` runs
`git blame` on every file (slow; safe to interrupt and rerun). Add
`--sample 2000` to blame a random sample of files in large repositories and
report an estimate instead. Reports then show the top owner of each repository
by commit count, by blame, and by line hash.

Repositories with a CODEOWNERS file also get a declared-ownership table: each
rule's declared owners next to the top owner of the same lines by line hash and
by blame (`codeowners.csv`).

### AI insights

`--ai` adds an AI-written executive summary, an OKR draft, and names for the
owner archetypes, using any OpenAI-compatible chat API, hosted or local
(default: OpenRouter with model `openai/gpt-6-luna`; set `OWNH_AI_MODEL` to use
another):

```bash
OPENROUTER_API_KEY=... ownh report --db acme.db --ai

# A local server needs no key:
OWNH_AI_BASE_URL=http://localhost:11434/v1 OWNH_AI_MODEL=<local model> ownh report --db acme.db --ai
```

Only percentages, size bands ("tens of millions of lines"), and trends leave
the machine; every person, repository, and quarter is replaced by a token and
restored locally. On OpenRouter, requests are always restricted to providers
that neither store nor train on data, and by default to zero-data-retention
endpoints (`OWNH_AI_ZDR=0` drops that second restriction). The
exact request is saved as `ai-request.json`; `--ai-dry-run` writes it without
sending anything. Every number in the AI text is checked against OWNH's
figures, and answers are cached per database.

| Variable                                | Meaning                                                                     |
|-----------------------------------------|-----------------------------------------------------------------------------|
| `OWNH_AI_KEY` or `OPENROUTER_API_KEY`   | API key; required for the default endpoint, optional with a custom base URL |
| `OWNH_AI_BASE_URL`                      | OpenAI-compatible endpoint (default `https://openrouter.ai/api/v1`)         |
| `OWNH_AI_MODEL`                         | model (default `openai/gpt-6-luna`)                                         |
| `OWNH_AI_ZDR`                           | `0` drops the zero-data-retention requirement (OpenRouter only)             |
| `OWNH_AI_TEMPERATURE`                   | a number (default 0), or `default` to send none                             |

### Ask the database

```bash
OPENROUTER_API_KEY=... ownh agent --db acme.db
```

Opens a terminal session where you can ask questions about the database ("who
owns the most of the payments repo?", "who owns the most punctuation in
payments?", "what does our principal owner actually own?", "who committed most
last month?"). It uses the same AI settings as `--ai`. Removals are recorded
per quarter, so questions about a shorter period are answered for the quarter
that contains it. Set `NO_COLOR=1` for output without colors. Names, emails,
repositories, paths, and code never leave the machine: the model sees tokens, and answers are
translated back locally. Counts, percentages, and quarters are sent. Every
request is logged to `report/<db>/agent-requests.jsonl`.

## Website

The site at [ownh.org](https://ownh.org) is `docs/index.html`, served by GitHub
Pages from the `docs/` folder. Its [sample
report](https://ownh.org/sample/report.html) is generated from six demonstration
repositories (`scripts/demo-repos.js`) with `npm run sample`. The method
whitepaper, [ownh-whitepaper.pdf](https://ownh.org/ownh-whitepaper.pdf), is
built from `whitepaper/ownh-whitepaper.tex` with `npm run whitepaper` (needs
pdflatex).

## How it works

1. Walk the combined history of all given repositories from the first commit.
2. Hash every added line exactly as written. Whitespace counts.
3. The first author to produce a hash owns it, permanently.
4. Score each repository's current tree by those owners and publish the leaderboard.

## License

Copyright 2026 Erik Wistrand. Licensed under the Apache License, Version 2.0;
see [LICENSE](LICENSE).
