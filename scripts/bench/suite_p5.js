// P5: deep pages. OFFSET/skip vs keyset ("continue after the last row you saw").
// Listing: all games, best Wilson score first, ties broken by id, 24 per page.
// Pages 1, 10, 100, 500, 1000, 2000 (page 2000 starts at row 47,976 of 50,000).
// MySQL: both variants forced onto a test-only index (wilson_score DESC, app_id) that matches the ORDER BY,
// so the only difference is how the page is reached. Dropped in `finally`.
// MongoDB: the existing idx_rating {wilson_score:-1, _id:1} on games already matches (read-only use).
// Keyset cursors (last row of the previous page) are worked out before timing, per database:
// 13,450 games have score 0, so deep pages are all ties, and MySQL (int id) and MongoDB (string _id)
// break those ties in a different order.

const PAGES = [1, 10, 100, 500, 1000, 2000];
const PER = 24;
const IDX = "idx_p5_score_id";

module.exports = async function suiteP5({ sql, games, measure }) {
    const drop = () => sql.query(`DROP INDEX ${IDX} ON game`).catch(() => {});
    try {
        await drop();
        await sql.query(`CREATE INDEX ${IDX} ON game (wilson_score DESC, app_id)`);

        const sqlOffset = `SELECT app_id, title, wilson_score FROM game FORCE INDEX (${IDX})
            ORDER BY wilson_score DESC, app_id LIMIT ${PER} OFFSET ?`;
        const sqlKeyset = `SELECT app_id, title, wilson_score FROM game FORCE INDEX (${IDX})
            WHERE wilson_score < ? OR (wilson_score = ? AND app_id > ?)
            ORDER BY wilson_score DESC, app_id LIMIT ${PER}`;
        const opts = { projection: { name: 1, wilson_score: 1 }, sort: { wilson_score: -1, _id: 1 }, limit: PER, hint: "idx_rating" };
        const monSkip = (n) => games.find({}, { ...opts, skip: n });
        const monKeyset = (c) => games.find(c ? { $or: [{ wilson_score: { $lt: c.s } }, { wilson_score: c.s, _id: { $gt: c.id } }] } : {}, opts);

        const sqlExplain = (s, p) => async () => (await sql.query(`EXPLAIN ANALYZE ${s}`, p))[0].map((r) => Object.values(r)[0]).join("\n");

        for (const page of PAGES) {
            const off = (page - 1) * PER;
            // cursor = last row of the previous page, from the offset query (not timed)
            let sc = null, mc = null;
            if (page > 1) {
                const r = (await sql.query(sqlOffset, [off - PER]))[0].at(-1);
                sc = [r.wilson_score, r.wilson_score, r.app_id];
                const d = (await monSkip(off - PER).toArray()).at(-1);
                mc = { s: d.wilson_score, id: d._id };
            }
            const sqlK = sc ? [sqlKeyset, sc] : [sqlOffset, [0]];
            const runSql = async (s, p) => (await sql.query(s, p))[0];

            // Correctness: offset and keyset return the same 24 ids in the same order, per database.
            const ids = (rows, f) => rows.map((r) => String(r[f])).join(",");
            const a = ids(await runSql(sqlOffset, [off]), "app_id"), b = ids(await runSql(...sqlK), "app_id");
            const c = ids(await monSkip(off).toArray(), "_id"), d = ids(await monKeyset(mc).toArray(), "_id");
            if (a !== b) throw new Error(`P5 check: MySQL page ${page} offset and keyset differ`);
            if (c !== d) throw new Error(`P5 check: MongoDB page ${page} skip and keyset differ`);
            if (a.split(",").length !== PER) throw new Error(`P5 check: page ${page} has fewer than ${PER} rows`);

            await measure("P5", `page_${String(page).padStart(4, "0")}`, [
                { name: "mysql-offset", run: async () => (await runSql(sqlOffset, [off])).length, explain: sqlExplain(sqlOffset, [off]) },
                { name: "mysql-keyset", run: async () => (await runSql(...sqlK)).length, explain: sqlExplain(...sqlK) },
                { name: "mongo-skip", run: async () => (await monSkip(off).toArray()).length, explain: () => monSkip(off).explain("executionStats") },
                { name: "mongo-keyset", run: async () => (await monKeyset(mc).toArray()).length, explain: () => monKeyset(mc).explain("executionStats") }
            ]);
        }
    } finally {
        await drop();
    }
};
