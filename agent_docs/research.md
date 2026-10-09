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

URLs were not recorded with the original research. Open question: add them
before citing in public copy.
