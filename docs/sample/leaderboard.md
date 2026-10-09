# OWNH Ownership Report

Repositories: 2. Lines under management: 24.
Excluded patterns: none.
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
