#!/usr/bin/env node
// =========================================================
// Builds IDENTICAL collections test data in three designs,
// for the performance comparison (test data only, never used by the site):
//
//   A. MySQL steamdb_bench   collection + collection_game  (JOIN to game)
//   B. MongoDB, embedded     bench_collections_embedded    (games array inside each document)
//   C. MongoDB, referenced   bench_collections_ref + bench_collection_items  ($lookup)
//
// B and C are in the `steamdb` MongoDB database next to `games`, because
// $lookup can only join collections in the same database. Every bench
// collection name starts with bench_ so it's clearly separate from the site's data.
//
// Same generator and seed as the demo data, matching indexes on all three,
// and a check at the end that all three hold exactly the same rows.
//
// Usage, from ~/steamdb-web (needs a MySQL user that can create tables in
// steamdb_bench, normally root):
//   read -s -p "MySQL root password: " P; echo
//   BENCH_MYSQL_PASSWORD="$P" node scripts/build_bench_collections.js --users 2000
//   unset P
// =========================================================

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mysqlLib = require("mysql2/promise");
const { connectMongo, getMongoDB } = require("../db/mongodb");
const { makeRng, makeUsers, makeCollectionsForUser, loadThemePools } = require("./lib/demo_collections");

const CHUNK_USERS = 500;     // generate and write 500 users at a time to keep memory low
const SQL_BATCH = 1000;      // rows per INSERT

function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function insertRows(sql, table, columns, rows) {
    for (let i = 0; i < rows.length; i += SQL_BATCH) {
        await sql.query(`INSERT INTO ${table} (${columns.join(", ")}) VALUES ?`, [rows.slice(i, i + SQL_BATCH)]);
    }
}

async function main() {
    const userCount = Number(arg("users", 2000));
    const seed = Number(arg("seed", 2003));
    if (!Number.isInteger(userCount) || userCount < 1 || userCount > 20000) {
        throw new Error("--users must be between 1 and 20000");
    }

    const sql = await mysqlLib.createConnection({
        host: process.env.MYSQL_HOST,
        port: Number(process.env.MYSQL_PORT) || 3306,
        user: process.env.BENCH_MYSQL_USER || "root",
        password: process.env.BENCH_MYSQL_PASSWORD,
        database: "steamdb_bench"
    });
    await connectMongo();
    const mongo = getMongoDB();

    // ---- Only use games that exist on BOTH sides ----
    const [gameRows] = await sql.query("SELECT app_id FROM game");
    const benchIds = new Set(gameRows.map((r) => r.app_id));
    console.log(`steamdb_bench.game has ${benchIds.size} games`);

    console.log("Reading theme pools from MongoDB games...");
    const pools = await loadThemePools(mongo.collection("games"), { allowedIds: benchIds });
    console.log(`  ${pools.length} themes usable`);
    if (!pools.length) throw new Error("No theme has enough games present in both databases");

    // ---- A. MySQL tables (recreated) ----
    await sql.query("DROP TABLE IF EXISTS collection_game");
    await sql.query("DROP TABLE IF EXISTS collection");
    await sql.query(`
        CREATE TABLE collection (
            collection_id INT NOT NULL PRIMARY KEY,
            user_id       INT NOT NULL,
            name          VARCHAR(150) NOT NULL,
            created_at    DATETIME NOT NULL,
            updated_at    DATETIME NOT NULL,
            UNIQUE KEY uq_user_name (user_id, name)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await sql.query(`
        CREATE TABLE collection_game (
            collection_id INT NOT NULL,
            game_id       INT NOT NULL,
            position      INT NOT NULL,
            added_at      DATETIME NOT NULL,
            PRIMARY KEY (collection_id, game_id),
            KEY idx_cg_order (collection_id, position),
            KEY idx_cg_game (game_id),
            FOREIGN KEY (collection_id) REFERENCES collection(collection_id) ON DELETE CASCADE,
            FOREIGN KEY (game_id) REFERENCES game(app_id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    // ---- B and C. MongoDB collections (recreated), indexes matching MySQL's ----
    const names = ["bench_collections_embedded", "bench_collections_ref", "bench_collection_items"];
    const existing = (await mongo.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
    for (const n of names) if (existing.includes(n)) await mongo.collection(n).drop();

    const embedded = mongo.collection("bench_collections_embedded");
    const refs = mongo.collection("bench_collections_ref");
    const items = mongo.collection("bench_collection_items");

    await embedded.createIndex({ user_id: 1, name: 1 }, { unique: true, name: "uq_user_name" });
    await embedded.createIndex({ "games.app_id": 1 }, { name: "idx_games_app_id" });
    await refs.createIndex({ user_id: 1, name: 1 }, { unique: true, name: "uq_user_name" });
    await items.createIndex({ collection_id: 1, app_id: 1 }, { unique: true, name: "pk_collection_game" });
    await items.createIndex({ collection_id: 1, position: 1 }, { name: "idx_order" });
    await items.createIndex({ app_id: 1 }, { name: "idx_game" });

    // ---- Generate once, write the same rows to all three ----
    const rng = makeRng(seed);
    const users = makeUsers(userCount, rng);
    let nextId = 1;
    let totalCollections = 0;
    let totalItems = 0;

    for (let start = 0; start < users.length; start += CHUNK_USERS) {
        const chunk = users.slice(start, start + CHUNK_USERS);
        const sqlCollections = [], sqlItems = [], embeddedDocs = [], refDocs = [], itemDocs = [];

        for (const u of chunk) {
            for (const c of makeCollectionsForUser(u.index, u.created_at, pools, rng)) {
                const id = nextId++;
                sqlCollections.push([id, c.user_id, c.name, c.created_at, c.updated_at]);
                embeddedDocs.push({ _id: id, ...c });
                refDocs.push({ _id: id, user_id: c.user_id, name: c.name, created_at: c.created_at, updated_at: c.updated_at });
                c.games.forEach((g, i) => {
                    sqlItems.push([id, Number(g.app_id), i + 1, g.added_at]);
                    itemDocs.push({ collection_id: id, app_id: g.app_id, position: i + 1, added_at: g.added_at });
                });
            }
        }

        await insertRows(sql, "collection", ["collection_id", "user_id", "name", "created_at", "updated_at"], sqlCollections);
        await insertRows(sql, "collection_game", ["collection_id", "game_id", "position", "added_at"], sqlItems);
        if (embeddedDocs.length) {
            await embedded.insertMany(embeddedDocs, { ordered: false });
            await refs.insertMany(refDocs, { ordered: false });
        }
        if (itemDocs.length) await items.insertMany(itemDocs, { ordered: false });

        totalCollections += sqlCollections.length;
        totalItems += sqlItems.length;
        console.log(`  users ${start + 1}-${start + chunk.length}: ${totalCollections} collections, ${totalItems} items so far`);
    }

    // ---- Check all three hold the same data ----
    const [[sqlCounts]] = await sql.query(`
        SELECT (SELECT COUNT(*) FROM collection) AS collections,
               (SELECT COUNT(*) FROM collection_game) AS items,
               (SELECT COUNT(DISTINCT user_id) FROM collection) AS users_with_collections`);
    const [embeddedItems] = await embedded.aggregate([
        { $group: { _id: null, n: { $sum: { $size: "$games" } } } }
    ]).toArray();

    const check = [
        { design: "A. MySQL", collections: sqlCounts.collections, items: sqlCounts.items },
        { design: "B. MongoDB embedded", collections: await embedded.countDocuments(), items: embeddedItems?.n ?? 0 },
        { design: "C. MongoDB referenced", collections: await refs.countDocuments(), items: await items.countDocuments() }
    ];
    console.log("\nAll three designs must match:");
    console.table(check);
    const ok = check.every((r) => r.collections === check[0].collections && r.items === check[0].items);
    if (!ok) throw new Error("Row counts differ between designs");

    // ---- Storage cost of each design (for the report) ----
    // ANALYZE refreshes InnoDB's statistics; without it the sizes below are stale
    await sql.query("ANALYZE TABLE collection, collection_game");
    const [sizes] = await sql.query(`
        SELECT table_name AS name, data_length AS data_bytes, index_length AS index_bytes
        FROM information_schema.tables
        WHERE table_schema = 'steamdb_bench' AND table_name IN ('collection', 'collection_game')`);
    const storage = sizes.map((s) => ({ store: `MySQL ${s.name ?? s.NAME}`, dataKB: Math.round((s.data_bytes ?? s.DATA_BYTES) / 1024), indexKB: Math.round((s.index_bytes ?? s.INDEX_BYTES) / 1024) }));
    for (const n of names) {
        const st = await mongo.command({ collStats: n });
        storage.push({ store: `MongoDB ${n}`, dataKB: Math.round(st.storageSize / 1024), indexKB: Math.round(st.totalIndexSize / 1024) });
    }
    console.log("\nStorage on disk:");
    console.table(storage);

    console.log(`\nDone: ${userCount} users, ${totalCollections} collections, ${totalItems} collection items, seed ${seed}.`);
    await sql.end();
}

main()
    .catch((err) => { console.error("Build failed:", err.message); process.exitCode = 1; })
    .finally(() => process.exit());
