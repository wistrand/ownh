# OWNH Ownership Report

Repositories: 2. Lines under management: 24.
OWNH 0.1.0.

## Principal owners

| Rank | Owner                     | Lines | Share |
|-----:|---------------------------|------:|------:|
|    1 | Alice <alice@example.com> |     8 | 33.3% |
|    2 | Frank <frank@example.com> |     3 | 12.5% |
|    3 | Judy <judy@example.com>   |     3 | 12.5% |
|    4 | Grace <grace@example.com> |     2 |  8.3% |
|    5 | Heidi <heidi@example.com> |     2 |  8.3% |
|    6 | Kate <kate@example.com>   |     2 |  8.3% |
|    7 | Leo <leo@example.com>     |     2 |  8.3% |
|    8 | Bob <bob@example.com>     |     1 |  4.2% |
|    9 | Carol <carol@example.com> |     1 |  4.2% |

## Ownership profiles

![Ownership profile: principal owners](owner-profile.svg)

![Governance profile: largest repositories](repo-profile.svg)

## Principal lines

![Ownership by line hash](ownership-by-line-hash.svg)

| Rank | Line                     | Lines | Share | Owner | First written in |
|-----:|--------------------------|------:|------:|-------|------------------|
|    1 | `"}"`                    |     3 | 12.5% | Alice | alpha            |
|    2 | `(binary) logo.png`      |     2 |  8.3% | Kate  | beta             |
|    3 | `"function a() {"`       |     2 |  8.3% | Alice | alpha            |
|    4 | `"  return 1;"`          |     2 |  8.3% | Alice | alpha            |
|    5 | `"tie();"`               |     2 |  8.3% | Heidi | alpha            |
|    6 | `"const shared = true;"` |     2 |  8.3% | Grace | beta             |
|    7 | `""`                     |     2 |  8.3% | Frank | beta             |
|    8 | `"// beta only"`         |     1 |  4.2% | Frank | beta             |
|    9 | `"}\r"`                  |     1 |  4.2% | Judy  | beta             |
|   10 | `"function a() {\r"`     |     1 |  4.2% | Judy  | beta             |

## Cross-repository ownership

Rows are the repository where a line lives; columns are the repository where
that line was first written, and so where its owner acquired it.

![Cross-repository ownership](cross-ownership.svg)

| Repository | Lines | Owned from other repos | Owned by non-contributors | Largest outside source |
|------------|------:|-----------------------:|--------------------------:|------------------------|
| alpha      |    13 |                  23.1% |                     23.1% | beta (23.1%)           |
| beta       |    11 |                  36.4% |                     36.4% | alpha (36.4%)          |

Non-contributors own lines in a repository without a single commit to it.

## Three ways to own a repository

The top owner of each repository by commit count, by `git blame`, and by line hash.
Blame shows "-" until `bin/ownh.js blame` has covered every file (or every file of its sample).
Values marked ~ are estimates from a random sample of files, with a 95% margin in percentage points.

| Repository           | By commits    | By blame      | By line hash  | Agree |
|----------------------|---------------|---------------|---------------|-------|
| **All repositories** | Alice (15.4%) | Frank (23.8%) | Alice (33.3%) | no    |
| alpha                | Alice (25.0%) | Alice (36.4%) | Alice (38.5%) | yes   |
| beta                 | Frank (20.0%) | Frank (50.0%) | Alice (27.3%) | no    |

The three methods agree on 1 of 2 repositories.

## Leverage

Lines owned today for every line written. Identical lines are owned by whoever wrote them first, so one
line written can be many lines owned.

### Highest leverage

| Owner                     | Lines written | Lines owned | Owned per line written |
|---------------------------|--------------:|------------:|-----------------------:|
| Grace <grace@example.com> |             1 |           2 |                   2.00 |
| Heidi <heidi@example.com> |             1 |           2 |                   2.00 |
| Leo <leo@example.com>     |             1 |           2 |                   2.00 |
| Alice <alice@example.com> |             5 |           8 |                   1.60 |
| Judy <judy@example.com>   |             3 |           3 |                   1.00 |
| Frank <frank@example.com> |             5 |           3 |                   0.60 |
| Carol <carol@example.com> |             2 |           1 |                   0.50 |
| Bob <bob@example.com>     |             4 |           1 |                   0.25 |

### Lowest retention among the most prolific writers

| Owner                     | Lines written | Lines owned | Owned per line written |
|---------------------------|--------------:|------------:|-----------------------:|
| Bob <bob@example.com>     |             4 |           1 |                   0.25 |
| Carol <carol@example.com> |             2 |           1 |                   0.50 |
| Frank <frank@example.com> |             5 |           3 |                   0.60 |
| Judy <judy@example.com>   |             3 |           3 |                   1.00 |
| Alice <alice@example.com> |             5 |           8 |                   1.60 |
| Grace <grace@example.com> |             1 |           2 |                   2.00 |
| Heidi <heidi@example.com> |             1 |           2 |                   2.00 |
| Leo <leo@example.com>     |             1 |           2 |                   2.00 |

## Code demolition

28 lines added and 4 removed in total; 4 of the removed lines (100.0%) belonged to someone other than the person removing them.

### Most lines removed that belonged to others

| Rank | Remover                   | Lines | Own lines removed |
|-----:|---------------------------|------:|------------------:|
|    1 | Carol <carol@example.com> |     2 |                 0 |
|    2 | Dave <dave@example.com>   |     1 |                 0 |
|    3 | Erin <erin@example.com>   |     1 |                 0 |

### Most lines lost to others

| Rank | Owner                     | Lines | Own lines removed |
|-----:|---------------------------|------:|------------------:|
|    1 | Bob <bob@example.com>     |     2 |                 0 |
|    2 | Alice <alice@example.com> |     1 |                 0 |
|    3 | Dave <dave@example.com>   |     1 |                 0 |

Removals inside merge commits are not counted: they are relative to git's re-run of the merge, not to a parent.

## Code survival

- All code: half-life of 7.9 years (projected; 82.0% of lines survive after 2.3 years).
- Alice: half-life of 13.2 years (projected; 88.9% of lines survive after 2.3 years).
- Frank: no lines have been deleted.
- Judy: no lines have been deleted.

![Code survival](code-survival.svg)

Copies of the same line are indistinguishable, so removals are paired with the oldest surviving copies of that line first. Lines still present count as surviving at their current age. A half-life marked projected extends an exponential decay through the last point.

## Outlook

- **Knowledge retention:** At the current rate, contributors with no commit in the past year will own the majority of the codebase by 2027 Q2 (now 29.2%; fit over 2024 Q1 to 2026 Q2, R² 0.26).
- **Principal owner:** Alice owns 33.3% of the codebase, and the trend is flat or falling (fit over 2024 Q1 to 2026 Q2, R² 0.61).
- **Blank lines:** 2 blank lines have been committed. At the current rate, the 5th arrives in 2033 Q2 (fit over 2024 Q1 to 2026 Q2, R² 0.27).

![Ownership outlook](ownership-outlook.svg)

![Blank line outlook](blank-line-outlook.svg)

| Quarter | Lines under management |    QoQ | New owners | Alice | Non-contributors | Inactive owners | Blank lines committed |
|---------|-----------------------:|-------:|-----------:|------:|-----------------:|----------------:|----------------------:|
| 2024 Q3 |                     14 |  +0.0% |          1 | 57.1% |            28.6% |            0.0% |                     2 |
| 2024 Q4 |                     14 |  +0.0% |          1 | 50.0% |            28.6% |            0.0% |                     2 |
| 2025 Q1 |                     14 |  +0.0% |          0 | 57.1% |            28.6% |           64.3% |                     2 |
| 2025 Q2 |                     14 |  +0.0% |          0 | 57.1% |            28.6% |           92.9% |                     2 |
| 2025 Q3 |                     15 |  +7.1% |          0 | 53.3% |            33.3% |           46.7% |                     2 |
| 2025 Q4 |                     17 | +13.3% |          1 | 47.1% |            35.3% |           41.2% |                     2 |
| 2026 Q1 |                     20 | +17.6% |          1 | 40.0% |            30.0% |           35.0% |                     2 |
| 2026 Q2 |                     24 | +20.0% |          2 | 33.3% |            29.2% |           29.2% |                     2 |

Projections continue the trend of the last 12 quarters (least-squares slope) from the latest value. Series are lines added minus lines removed, each line owned by whoever first wrote it; at 2026 Q2 they total 24 lines against 24 at HEAD (lines added on branches whose changes a merge discarded are never removed). The blank-line series counts blank lines as committed. "Inactive" means no commit in the current or previous three quarters. "Now" is the quarter of the newest commit analyzed.

## Oddities

- The most-owned line has no letters or digits. `"}"` appears 3 times (12.5% of all lines) and belongs to Alice, who wrote it first in alpha.
- 3 of the top 10 lines are whitespace or punctuation. Together they hold 25.0% of all lines: `"}"`, `""`, `"}\r"`.
- The same line, owned twice. `"}"` belongs to Alice and `"}\r"` (Windows line ending) to Judy.
- The same line, owned twice. `"function a() {"` belongs to Alice and `"function a() {\r"` (Windows line ending) to Judy.
- A binary file is one of the most-owned lines. The file first committed as `logo.png` exists 2 times with identical content. Each copy is one line, owned by Kate.
- 1 of 2 repositories is owned by someone who never committed to it. beta (Alice, 27.3%).
- Carol has removed 2 lines that belonged to others. More than anyone else, against 0 of their own.
- 1 line was added again after being deleted. Each went straight back to its original owner (1 distinct line).

## Repositories

### alpha

| Rank | Owner                     | Lines | Share | Commits here |
|-----:|---------------------------|------:|------:|--------------|
|    1 | Alice <alice@example.com> |     5 | 38.5% | yes          |
|    2 | Leo <leo@example.com>     |     2 | 15.4% | yes          |
|    3 | Bob <bob@example.com>     |     1 |  7.7% | yes          |
|    4 | Carol <carol@example.com> |     1 |  7.7% | yes          |
|    5 | Frank <frank@example.com> |     1 |  7.7% | none         |
|    6 | Grace <grace@example.com> |     1 |  7.7% | none         |
|    7 | Heidi <heidi@example.com> |     1 |  7.7% | yes          |
|    8 | Kate <kate@example.com>   |     1 |  7.7% | none         |

### beta

| Rank | Owner                     | Lines | Share | Commits here |
|-----:|---------------------------|------:|------:|--------------|
|    1 | Alice <alice@example.com> |     3 | 27.3% | none         |
|    2 | Judy <judy@example.com>   |     3 | 27.3% | yes          |
|    3 | Frank <frank@example.com> |     2 | 18.2% | yes          |
|    4 | Grace <grace@example.com> |     1 |  9.1% | yes          |
|    5 | Heidi <heidi@example.com> |     1 |  9.1% | none         |
|    6 | Kate <kate@example.com>   |     1 |  9.1% | yes          |

## Excluded patterns

None. Every file was analyzed.
