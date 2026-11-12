// P2: does index field order matter? "Best of 2019" (2019 releases, best Wilson score first, top 50).
// Same question as P3 Q2. Three index orders per database, each forced with FORCE INDEX / hint:
//   date-score  range field first                     (release_date, wilson_score DESC, id)
//   score-date  sort field first, tie-breaker missing (wilson_score, release_date)  -> can't serve ORDER BY score, id
//   esr         whole sort key first, then the range  (wilson_score DESC, id, release_date)
// MySQL runs on steamdb_bench.game; MongoDB on a test-only copy (bench_p2_games), never on live games.
// Everything this suite creates is dropped in `finally`, even if a run fails.

const SQL_IDX = { "date-score": "idx_p2_date_score", "score-date": "idx_game_wilson_date", esr: "idx_p2_esr" };
const SQL_CREATE = {
    idx_p2_date_score: "CREATE INDEX idx_p2_date_score ON game (release_date, wilson_score DESC, app_id)",
    idx_p2_esr: "CREATE INDEX idx_p2_esr ON game (wilson_score DESC, app_id, release_date)"
};
const MONGO_IDX = {
    "date-score": { release_date: 1, wilson_score: -1, _id: 1 },
    "score-date": { wilson_score: -1, release_date: 1, _id: 1 },
    esr: { wilson_score: -1, _id: 1, release_date: 1 }
};

module.exports = async function suiteP2({ sql, db, games, measure }) {
    const copy = db.collection("bench_p2_games");
    const dropSqlIdx = async () => {
        for (const name of Object.keys(SQL_CREATE)) await sql.query(`DROP INDEX ${name} ON game`).catch(() => {});
    };
    try {
        await dropSqlIdx();
        for (const ddl of Object.values(SQL_CREATE)) await sql.query(ddl);
        await copy.drop().catch(() => {});
        await games.aggregate([{ $project: { name: 1, release_date: 1, wilson_score: 1 } }, { $out: "bench_p2_games" }]).toArray();
        for (const [v, key] of Object.entries(MONGO_IDX)) await copy.createIndex(key, { name: `idx_p2_${v}` });

        const q = (idx) => `SELECT app_id, title, wilson_score FROM game FORCE INDEX (${idx})
            WHERE release_date >= '2019-01-01' AND release_date < '2020-01-01'
            ORDER BY wilson_score DESC, app_id LIMIT 50`;
        const D = [new Date(Date.UTC(2019, 0, 1)), new Date(Date.UTC(2020, 0, 1))];
        const mq = (v) => copy.find({ release_date: { $gte: D[0], $lt: D[1] } }, { projection: { name: 1, wilson_score: 1 } })
            .sort({ wilson_score: -1, _id: 1 }).limit(50).hint(`idx_p2_${v}`);

        // Correctness: within a DB every variant returns the same 50 ids in the same order;
        // across DBs the same 50 ids as a set.
        const variants = Object.keys(SQL_IDX);
        const sqlIds = {}, monIds = {};
        for (const v of variants) {
            sqlIds[v] = (await sql.query(q(SQL_IDX[v])))[0].map((r) => String(r.app_id)).join(",");
            monIds[v] = (await mq(v).toArray()).map((d) => d._id).join(",");
        }
        for (const v of variants) {
            if (sqlIds[v] !== sqlIds.esr) throw new Error(`P2 check: MySQL ${v} differs from esr`);
            if (monIds[v] !== monIds.esr) throw new Error(`P2 check: MongoDB ${v} differs from esr`);
        }
        const a = new Set(sqlIds.esr.split(",")), b = monIds.esr.split(",");
        if (a.size !== 50 || b.length !== 50 || !b.every((id) => a.has(id))) throw new Error("P2 check: MySQL and MongoDB top-50 sets differ");
        console.log("\n  [P2] check passed: 6 variants, same 50 ids");

        const sqlExplain = (s) => async () => (await sql.query(`EXPLAIN ANALYZE ${s}`))[0].map((r) => Object.values(r)[0]).join("\n");
        await measure("P2", "Q2_best_of_2019_index_order", [
            ...variants.map((v) => ({ name: `mysql-${v}`, run: async () => (await sql.query(q(SQL_IDX[v])))[0].length, explain: sqlExplain(q(SQL_IDX[v])) })),
            ...variants.map((v) => ({ name: `mongo-${v}`, run: async () => (await mq(v).toArray()).length, explain: () => mq(v).explain("executionStats") }))
        ]);
    } finally {
        await dropSqlIdx();
        await copy.drop().catch(() => {});
    }
};
