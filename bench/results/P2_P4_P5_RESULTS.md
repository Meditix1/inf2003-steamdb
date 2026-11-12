# P2, P4, P5 results (4 Nov 2026)

Run on the project VM (2 GB RAM, MySQL 8.4.11, MongoDB 8.3.11) with the team's harness: `node scripts/bench/bench.js --suite p2|p4|p5 --impl after --label after`. Each variant had 3 warm-up runs and 30 timed runs, alternating order each round. Rows were appended to `bench/results/summary.csv`, and the plans are in `bench/results/explain/after/P2_*`, `P4_*` and `P5_*`. Suite code is in `scripts/bench/suite_p2.js`, `suite_p4.js` and `suite_p5.js`, with copies in this folder.

**Use the medians.** The VM was swapping (~930 MB) during the runs, so many p95 values sit at about 190–230 ms whatever the query. That's machine noise, not the query.

Every suite checks correctness before timing. All variants must return the same rows, or the run stops. All checks passed. Test indexes and copies are created inside the suite and dropped in `finally`. After the runs, `steamdb_bench.game` has only its original indexes (PRIMARY, GAME_TAG_ibfk_1, idx_game_wilson_date), `bench_p2_games` is gone, and live `steamdb.games` was never modified.

## P2: does index field order matter? ("Best of 2019", top 50 by Wilson score)

2019 has 3,207 of 50,000 games (6.4%). Each variant is forced onto one index.

| Index order | MySQL median | MySQL plan | MongoDB median | MongoDB keys / docs examined, plan |
|---|---|---|---|---|
| Range first: (release_date, score, id) | 11.2 ms | range scan of 3,207 rows, then **Sort** | 10.4 ms | 3,207 / 50, IXSCAN > **SORT** > FETCH |
| Sort field first, but no tie-breaker: (score, release_date) | 29.9 ms | **full table scan** (50,000 rows) + Sort | 515.4 ms | 50,000 / 50,000, IXSCAN > FETCH > **SORT** |
| **ESR**: whole sort key, then range: (score, id, release_date) | **3.5 ms** | index scan in order, stops after 616 rows, **no sort** | **5.1 ms** | **616 / 616**, IXSCAN > FETCH, **no SORT** |

**Finding:** the ESR order wins in both databases: 3.2× faster than range-first in MySQL and 2.0× faster in MongoDB. It reads rows already in sorted order and stops once it has 50 matches (616 index entries), so there is no sort step. The middle row is the key lesson. Putting the sort field first is not enough: the index must cover the whole `ORDER BY` (score and id) before the range field. Otherwise it's useless for sorting and becomes the worst choice, 2.7× slower than range-first in MySQL and 50× slower in MongoDB.

## P4: correlated subquery vs rewrite ("paid games priced below their genre's average")

Scope: genre "Massively Multiplayer" (1,146 games, 502 paid), for every variant. The full data is too slow for repeated runs. One correlated run on Racing alone took 27 s, and two genres exceeded 60 s. MySQL 8.4 has `subquery_to_derived=off` by default, so it doesn't rewrite the subquery itself. Free games are excluded from both the averages and the results. All 5 variants return the same 358 rows, and MySQL and MongoDB agree exactly.

| Variant | Median | Evidence |
|---|---|---|
| MySQL correlated subquery | 6,759 ms | the dependent subquery re-runs the genre average once per outer row |
| MySQL CTE of genre averages + JOIN | 9.4 ms | average computed once |
| MySQL window `AVG() OVER (PARTITION BY genre)` | **7.7 ms** | one pass |
| MongoDB correlated `$lookup` (pipeline per document) | 11,296 ms | **575,292** documents examined |
| MongoDB `$setWindowFields` | **19.7 ms** | **1,146** documents examined |

**Finding:** rewriting the correlated subquery is about 870× faster in MySQL and 570× faster in MongoDB. The correlated version costs O(n²) (every row re-reads its whole genre), while the rewrite reads each row once. In the dry run the correlated MySQL query took 1.7 s per run; under 30 back-to-back runs on the swapping VM it took 6.8 s. The ranking never changed.

## P5: deep pages, OFFSET/skip vs keyset (24 per page, best score first)

MySQL uses a test index `(wilson_score DESC, app_id)` that matches the `ORDER BY`, forced for both variants. MongoDB uses the existing `idx_rating {wilson_score:-1, _id:1}`.

| Page (offset) | MySQL OFFSET | MySQL keyset | MongoDB skip | MongoDB keyset |
|---|---|---|---|---|
| 1 (0) | 1.4 ms | 1.3 ms | 3.7 ms | 3.2 ms |
| 10 (216) | 2.4 | 1.5 | 3.4 | 2.8 |
| 100 (2,376) | 7.6 | 1.4 | 5.1 | 2.5 |
| 500 (11,976) | 218.9 | 1.5 | 11.4 | 2.6 |
| 1000 (23,976) | 248.8 | 1.5 | 20.2 | 2.7 |
| 2000 (47,976) | **492.5** | **1.3** | **53.5** | **2.8** |

Plans at page 2000:
- **MySQL OFFSET:** index scan reading 48,000 rows, then throws away 47,976.
- **MySQL keyset:** index range scan reading 24 rows.
- **MongoDB skip:** 48,000 keys examined.
- **MongoDB keyset:** 24 keys examined.

**Finding:** OFFSET/skip cost grows with the page number, because the database still walks every skipped row. Keyset stays flat (~1.4 ms MySQL, ~2.7 ms MongoDB) whichever page is requested. At page 2000 keyset is 370× faster in MySQL and 19× faster in MongoDB.

Side note: 13,450 games have a Wilson score of 0, so every page from about 562 onward is a tie on score. MySQL breaks ties by integer `app_id`, and MongoDB by its string `_id`. The two databases therefore show different games on those deep pages. Each database is still consistent with itself, which the correctness check verifies.

## Notes for the write-up
- P2 extends P3 Q2 (same query), and P5 uses the same score order as the homepage "best rated" sort.
- The hook line that runs these suites was added to `scripts/bench/bench.js`. A backup of the original is at `scripts/bench/bench.js.bak-2026-11-04`. `--suite all` still runs only P1/P3/P6.
