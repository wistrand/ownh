# Research: line-hash code ownership

Question: has line-based content hashing been used to define code ownership?
Short answer: not prominently. Line-level hashing appears in adjacent problems
(copy detection, license provenance, file-level origin), but ownership research
and tools track lines with diffs, not hashes. No well-known paper or tool was
found that defines ownership as "first introducer of this line's hash."

Unverified: no formal patent search was done. The provenance area is heavily
patented, so do not claim OWNH's method is novel in public copy.

## Contents
- How line ownership is actually computed
- Where content hashing is used
- Why pure line hashes are not used
- Similar systems
- Observed in runs: subtree syncs and the repository-name tiebreak
- Sources

## How line ownership is actually computed

- **Diff-based blame is the norm.** `git blame` reports the author and commit
  that last modified each line. Line-based ownership gives a developer more
  ownership the larger their share of a file's authored lines. One study
  recommends line-based ownership for accountability uses (authorship
  attribution, IP) and commit-based ownership for bug-fixing and quality
  planning, and finds the two methods disagree on who the major developers are
  [1]. That disagreement is the factual basis for the three-way comparison in
  [design.md](design.md).
- **Line tracking research uses similarity, not exact hashes.** Canfora et al.
  combine information retrieval with Levenshtein distance to infer line-level
  changes [2]. Meng et al. note git, svn, and mercurial report only the most
  recent author and extract a line's full history for authorship [3].
- **Token level.** cregit does token-level blame for git; German found line- and
  token-based authorship numbers did not differ much overall [4][5].

## Where content hashing is used

- **Whole-file blob hashes.** World of Code studies treat the first repository
  to commit a blob as its origin and the first author as its creator [6][7].
  This is "first introducer of a hash = author", but at file level, and only for
  exact copies. Closest real analogue to OWNH.
- **Snippet fingerprints for provenance.** SCANOSS uses winnowing for approximate
  in-file matching [8]; code-provenance patents fingerprint fragments after
  stripping whitespace and non-printable characters [9]. Used for license
  compliance, not team ownership.
- **AI attribution.** Git AI records per-edit checkpoints and rewrites
  authorship logs to survive rebase, squash, and cherry-pick [10]. Metadata
  carried along history, not hash lookup.

## Why pure line hashes are not used

Common lines (`}`, blank lines, `return;`) collide constantly, and any
one-character edit changes the hash. Formatters break them. Entire's docs make
the same point: per-line attribution breaks when lines shift, split, merge, or
get rewritten [11]. This is exactly the failure set OWNH exploits.

The non-satirical version of the idea would be normalized line hashes plus
context (neighboring lines) as a fast first pass, with similarity matching as a
fallback. Out of scope here.

## Similar systems

Surveyed via web search; details come from project docs and search summaries,
not from running the tools. Nothing found assigns ownership by the first
introducer of a line's exact content hash, and nothing found aggregates that
across repositories. The closest analogues work at file or blob level.

### Ownership and expertise tools (blame- or churn-based)

| Tool                     | Ownership rule                                                                     | Relation to OWNH                                                                   |
|--------------------------|------------------------------------------------------------------------------------|------------------------------------------------------------------------------------|
| git-fame                 | Lines per author from `git blame`; excludes, date limits, person-month estimates   | Latest editor per line, one repo. OWNH: first writer of the content, any repo.    |
| git-who                  | Most significant contributor per repo, directory, file, or revision range          | Same family as git-fame, with a tree view.                                        |
| Hercules (src-d)         | Mines full history incl. merges; ownership and burndown outputs; merges repos      | Closest in scope (multi-repo, full history). Its v4 notes say the full-history walk made `git/git` go from under 4 minutes to 2 h 45 min. |
| truckfactor (PyPI)       | File owned by whoever edited the most lines; greedy removal of authors             | Bus factor, not line ownership.                                                   |
| CodeScene                | Knowledge maps, "former contributor" knowledge loss, off-boarding simulation       | Commercial version of the same question; warns against use for performance evaluation. |
| git-of-theseus           | Surviving lines by year added (cohorts), Kaplan-Meier survival curves              | Measures age of code, not owners. A cohort chart of surviving lines is a possible OWNH report. |

### Research on ownership metrics

- **Degree of Authorship and truck factor** (Avelino, Valente et al.): DOA from
  version history plus a greedy truck-factor heuristic; on 133 popular GitHub
  projects, 46% had truck factor 1 and 28% truck factor 2 [13][14].
- **"Don't Touch My Code!"** (Bird, Nagappan, Murphy, Gall, Devanbu, ESEC/FSE
  2011): ownership measures (minor contributors, top owner's share) correlate
  with pre- and post-release failures in Windows Vista and 7. Test of Time award
  2021. A Microsoft replication confirmed it; an open-source replication
  (Foucault et al.) questioned whether ownership generally affects quality [15][16].
  Useful context for the pitch: ownership metrics have a respectable research
  history, which is what makes OWNH's deadpan claims plausible.

### Content-addressed provenance (closest real analogues)

- **Software Heritage provenance**: given a SWHID for a content, directory, or
  revision, returns where it was found; the default "best" answer is the origin
  with the oldest revision (by commit date) containing the object. This is
  OWNH's first-introducer rule at file level, over the whole public archive [17].
- **World of Code copy-based reuse** (Jahanshahi, Reid, Mockus): first commit
  date of each blob across repositories identifies the originating repository [6].
  Same rule, again at blob level. OWNH's "go global" gag is this applied to lines.

### Mitigations git itself ships for the problems OWNH exaggerates

- `git blame -M` / `-C` (repeatable up to three times) follows lines moved or
  copied between files; `--ignore-revs-file` / `blame.ignoreRevsFile` skips
  formatting commits so they don't take over blame [18]. OWNH deliberately does
  neither: a formatter commit transfers ownership.

### Parody tools (tone references)

- **git-blame-someone-else** (Jay Phelps): rewrites a commit's author to "blame
  someone else for your bad code"; explicitly a joke, rewrites history [19].
- **git-self-blame**: the reverse, take the blame without changing history [20].
- **FizzBuzzEnterpriseEdition**: FizzBuzz built "to the high quality standards of
  enterprise software"; the canonical deadpan enterprise parody, the closest
  tonal sibling to OWNH [21].

Positioning, inferred from the above: OWNH sits where the ownership tools and
the provenance systems meet. It takes provenance's first-introducer rule, applies
it at line granularity, and reports it with ownership-tool vocabulary. Each half
is legitimate on its own; the combination is the joke.

## Observed in runs: subtree syncs and the repository-name tiebreak

Not from the literature: observed on a public programming-language project
analyzed with its tool repositories (formatter, linter, IDE server, interpreter,
package manager, installer, book). No source; reproduce by indexing a main
repository together with repositories that are subtree-synced into it.

- **Mechanism.** Subtree syncs (git subtree, or josh-style tools) import a
  tool repository's history into the main repository. The same commits, with
  the same author times, then exist in both, so each line has two introductions
  with equal author time. The ownership key `(author_time, repository name,
  topo)` breaks the tie by repository name, in byte order. The owner (a person)
  is the same either way, but the origin repository is whichever name sorts
  first.
- **Result.** Tools whose names sort after the main repository's name lost
  their own code to it: three tool repositories each had 99.7% to 99.9% of their
  lines "written elsewhere", nearly all credited to the main repository. The
  interpreter, whose name sorts before it, kept 57.6% of its lines as its own
  and was credited with 1.6% of the main repository. Which repository "owns" a
  whole tool is decided by alphabetical order.
- **Why it stays.** The tiebreak exists so that results do not depend on the
  order repositories are given (an invariant in CLAUDE.md); any deterministic
  tiebreak would hand the shared history to one side. Same family as the
  formatter and rename absurdities: an honest rule producing an arbitrary
  answer. It applies to any history-preserving import (subtree merges,
  monorepo migrations that keep history, forks analyzed alongside their
  upstream).
- **Where it shows.** The cross-repository heatmap and the "written
  elsewhere" share per repository; the AI summary, which rounds to whole
  percent, called it "100% of their lines were written elsewhere".

## Sources

1. Code Ownership: Principles, Differences... arXiv 2408.12807
2. Canfora et al., Identifying Changed Source Code Lines, MSR'07
3. Meng et al., Mining Software Repositories for Accurate Authorship
4. cregit token-level blame (Linux.com)
5. Token-based authorship information from Git (LWN)
6. Beyond Dependencies: Copy-Based Reuse, arXiv 2409.04830
7. Hackathon Code Creation and Reuse (NSF PAR)
8. Efficient Prior Publication Identification, arXiv 2207.11057
9. Code provenance review patent US8307351
10. Git AI (GitHub)
11. Entire attribution FAQ
12. Kosli: git blame guide
13. Avelino et al., What is the Truck Factor of popular GitHub applications? https://peerj.com/preprints/1233
14. Avelino, Identifying key developers using code authorship metrics (PhD thesis, UFMG 2018) https://homepages.dcc.ufmg.br/~mtov/diss/2018-guilherme-avelino.pdf
15. Bird et al., Don't Touch My Code! (ESEC/FSE 2011) https://www.microsoft.com/en-us/research/?p=161465
16. Examining Ownership Models in Software Teams (SLR and replication) https://arxiv.org/pdf/2405.15665
17. Software Heritage provenance docs https://docs.softwareheritage.org/devel/swh-provenance
18. git-blame manual https://git-scm.com/docs/git-blame
19. git-blame-someone-else https://github.com/jayphelps/git-blame-someone-else
20. git-self-blame https://github.com/jacobevelyn/git-self-blame
21. FizzBuzzEnterpriseEdition https://github.com/EnterpriseQualityCoding/FizzBuzzEnterpriseEdition
22. Hercules v4 notes https://sourced.tech/blog-sub/post/hercules-v4
23. git-of-theseus https://github.com/erikbern/git-of-theseus
24. CodeScene knowledge distribution https://codescene.io/docs/guides/social/knowledge-distribution.html
25. truckfactor https://pypi.org/project/truckfactor
26. Beyond Dependencies: Copy-Based Reuse (also [6]) https://arxiv.org/abs/2409.04830

URLs for sources 1-12 were not recorded with the original research (except [6],
see [26]). Open question: add them before citing in public copy.
