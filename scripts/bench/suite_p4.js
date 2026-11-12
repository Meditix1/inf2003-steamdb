// P4: correlated subquery vs rewrite. "Paid games priced below their genre's average price."
// Output: one row per (game, genre) pair where price < that genre's average paid price.
// Scope: genre 'Massively Multiplayer' (1,146 games, 502 paid). The correlated version re-runs the average
// per row (MySQL 8.4 keeps subquery_to_derived=off), so cost grows with n^2: Racing alone took 27 s per run,
// which is too slow for repeated runs. Every variant uses the same scope.
// Free games (price 0) are excluded from both the averages and the output.
// Read-only: no indexes or collections are created.

const GENRE = "Massively Multiplayer";

const SQL = {
    correlated: `SELECT g.app_id, g.title, g.price, ge.name AS genre
        FROM game g JOIN game_genre gg ON gg.game_id = g.app_id JOIN genre ge ON ge.genre_id = gg.genre_id
        WHERE ge.name = ? AND g.price > 0
          AND g.price < (SELECT AVG(g2.price) FROM game g2 JOIN game_genre gg2 ON gg2.game_id = g2.app_id
                         WHERE gg2.genre_id = gg.genre_id AND g2.price > 0)`,
    cte: `WITH avg_price AS (
            SELECT gg.genre_id, AVG(g.price) AS avg_p
            FROM game g JOIN game_genre gg ON gg.game_id = g.app_id JOIN genre ge ON ge.genre_id = gg.genre_id
            WHERE ge.name = ? AND g.price > 0 GROUP BY gg.genre_id)
        SELECT g.app_id, g.title, g.price, ge.name AS genre
        FROM game g JOIN game_genre gg ON gg.game_id = g.app_id JOIN genre ge ON ge.genre_id = gg.genre_id
        JOIN avg_price a ON a.genre_id = gg.genre_id
        WHERE g.price > 0 AND g.price < a.avg_p`,
    window: `SELECT app_id, title, price, genre FROM (
            SELECT g.app_id, g.title, g.price, ge.name AS genre, AVG(g.price) OVER (PARTITION BY gg.genre_id) AS avg_p
            FROM game g JOIN game_genre gg ON gg.game_id = g.app_id JOIN genre ge ON ge.genre_id = gg.genre_id
            WHERE ge.name = ? AND g.price > 0) t
        WHERE price < avg_p`
};

const base = [{ $match: { genres: GENRE, price: { $gt: 0 } } }, { $unwind: "$genres" }, { $match: { genres: GENRE } }];
const PIPE = {
    // correlated: for every game, look up all games of its genre again and average them (uses the genres index)
    lookup: [...base,
        { $lookup: { from: "games", localField: "genres", foreignField: "genres", as: "g",
            pipeline: [{ $match: { price: { $gt: 0 } } }, { $group: { _id: null, avg: { $avg: "$price" } } }] } },
        { $match: { $expr: { $lt: ["$price", { $first: "$g.avg" }] } } },
        { $project: { name: 1, price: 1, genre: "$genres" } }],
    // rewrite: one pass, average per genre computed by a window over the partition
    window: [...base,
        { $setWindowFields: { partitionBy: "$genres", output: { avg: { $avg: "$price" } } } },
        { $match: { $expr: { $lt: ["$price", "$avg"] } } },
        { $project: { name: 1, price: 1, genre: "$genres" } }]
};

module.exports = async function suiteP4({ sql, games, measure }) {
    const runSql = async (k) => (await sql.query(SQL[k], [GENRE]))[0];
    const runMongo = (k) => games.aggregate(PIPE[k], { allowDiskUse: true }).toArray();

    // Correctness: identical (app_id, genre) sets within each DB; compare counts across DBs
    // (MySQL price is DECIMAL, MongoDB price is a double, so a boundary row could differ).
    const key = (id, g) => `${id}|${g}`;
    const s = {}, m = {};
    for (const k of Object.keys(SQL)) s[k] = new Set((await runSql(k)).map((r) => key(r.app_id, r.genre)));
    for (const k of Object.keys(PIPE)) m[k] = new Set((await runMongo(k)).map((d) => key(d._id, d.genre)));
    const same = (x, y) => x.size === y.size && [...x].every((v) => y.has(v));
    if (!same(s.correlated, s.cte) || !same(s.correlated, s.window)) throw new Error("P4 check: MySQL variants differ");
    if (!same(m.lookup, m.window)) throw new Error("P4 check: MongoDB variants differ");
    const onlySql = [...s.cte].filter((v) => !m.window.has(v)), onlyMongo = [...m.window].filter((v) => !s.cte.has(v));
    console.log(`\n  [P4] check passed: MySQL ${s.cte.size} rows, MongoDB ${m.window.size} rows; only in MySQL ${onlySql.length}, only in MongoDB ${onlyMongo.length}`);

    const sqlExplain = (k) => async () => (await sql.query(`EXPLAIN ANALYZE ${SQL[k]}`, [GENRE]))[0].map((r) => Object.values(r)[0]).join("\n");
    await measure("P4", "Q_below_genre_avg", [
        ...Object.keys(SQL).map((k) => ({ name: `mysql-${k}`, run: async () => (await runSql(k)).length, explain: sqlExplain(k) })),
        ...Object.keys(PIPE).map((k) => ({ name: `mongo-${k}`, run: async () => (await runMongo(k)).length,
            explain: () => games.aggregate(PIPE[k], { allowDiskUse: true }).explain("executionStats") }))
    ]);
};
