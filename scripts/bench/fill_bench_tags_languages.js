#!/usr/bin/env node
// =========================================================
// Fills steamdb_bench.game_tag and game_language FROM MongoDB `games`,
// so the relational copy holds exactly the same tags (with vote counts)
// and languages as MongoDB. Safe to re-run: it rebuilds both tables.
//
// Usage, from ~/steamdb-web:
//   read -s -p "MySQL root password: " P; echo
//   BENCH_MYSQL_PASSWORD="$P" node scripts/bench/fill_bench_tags_languages.js; unset P
// Afterwards free the binary logs it created:
//   PURGE BINARY LOGS BEFORE NOW();
// =========================================================

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const mysqlLib = require("mysql2/promise");
const { connectMongo, getMongoDB } = require("../../db/mongodb");

const BATCH = 5000;

// Raw tags are { "Cozy": 120, ... } or [] for untagged games
function tagEntries(doc) {
    return doc.tags && !Array.isArray(doc.tags) && typeof doc.tags === "object"
        ? Object.entries(doc.tags) : [];
}

const stringsOf = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === "string" && s.trim()) : []);

async function main() {
    const sql = await mysqlLib.createConnection({
        host: process.env.MYSQL_HOST,
        port: Number(process.env.MYSQL_PORT) || 3306,
        user: process.env.BENCH_MYSQL_USER || "root",
        password: process.env.BENCH_MYSQL_PASSWORD,
        database: "steamdb_bench"
    });
    await connectMongo();
    const games = getMongoDB().collection("games");

    // Language strings in the raw data can be long; widen the column
    await sql.query("ALTER TABLE language MODIFY name VARCHAR(255) NOT NULL");
    await sql.query(`
        CREATE TABLE IF NOT EXISTS game_tag (
            game_id INT NOT NULL,
            tag_id  INT NOT NULL,
            votes   INT NOT NULL DEFAULT 0,
            PRIMARY KEY (game_id, tag_id),
            KEY idx_game_tag_tag (tag_id, game_id),
            -- named explicitly: game's old GAME_TAG_ibfk_1 would clash with the default name
            CONSTRAINT fk_bench_game_tag_game FOREIGN KEY (game_id) REFERENCES game(app_id) ON DELETE CASCADE,
            CONSTRAINT fk_bench_game_tag_tag  FOREIGN KEY (tag_id)  REFERENCES tag(tag_id)  ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await sql.query("TRUNCATE TABLE game_tag");
    await sql.query("TRUNCATE TABLE game_language");

    const [gameRows] = await sql.query("SELECT app_id FROM game");
    const benchIds = new Set(gameRows.map((r) => r.app_id));

    // ---- Pass 1: every distinct tag and language name ----
    const tagNames = new Set();
    const langNames = new Set();
    for await (const doc of games.find({}, { projection: { tags: 1, supported_languages: 1, full_audio_languages: 1 } })) {
        for (const [t] of tagEntries(doc)) tagNames.add(t);
        stringsOf(doc.supported_languages).forEach((l) => langNames.add(l));
        stringsOf(doc.full_audio_languages).forEach((l) => langNames.add(l));
    }

    // Insert names; the table's case-insensitive collation merges near-duplicates,
    // so ids are looked up by the database, not by exact JavaScript string
    async function idMap(table, idCol, names) {
        const list = [...names];
        for (let i = 0; i < list.length; i += 500) {
            await sql.query(`INSERT IGNORE INTO ${table} (name) VALUES ?`, [list.slice(i, i + 500).map((n) => [n])]);
        }
        const map = new Map();
        for (const n of list) {
            const [[row]] = await sql.query(`SELECT ${idCol} AS id FROM ${table} WHERE name = ?`, [n]);
            map.set(n, row.id);
        }
        return map;
    }
    const tagIds = await idMap("tag", "tag_id", tagNames);
    const langIds = await idMap("language", "language_id", langNames);
    console.log(`${tagIds.size} tag names, ${langIds.size} language names`);

    // ---- Pass 2: link rows ----
    let tagRows = [], langRows = [], nTag = 0, nLang = 0, skipped = 0;
    const flush = async () => {
        if (tagRows.length) await sql.query("INSERT IGNORE INTO game_tag (game_id, tag_id, votes) VALUES ?", [tagRows]);
        if (langRows.length) await sql.query("INSERT IGNORE INTO game_language (game_id, language_id, has_full_audio) VALUES ?", [langRows]);
        tagRows = []; langRows = [];
    };

    for await (const doc of games.find({}, { projection: { tags: 1, supported_languages: 1, full_audio_languages: 1 } })) {
        const id = Number(doc._id);
        if (!benchIds.has(id)) { skipped++; continue; }

        for (const [t, votes] of tagEntries(doc)) {
            tagRows.push([id, tagIds.get(t), Number(votes) || 0]); nTag++;
        }
        // Full audio implies supported: one row per language, flag for full audio
        const full = new Set(stringsOf(doc.full_audio_languages));
        const langs = new Set([...stringsOf(doc.supported_languages), ...full]);
        for (const l of langs) {
            langRows.push([id, langIds.get(l), full.has(l) ? 1 : 0]); nLang++;
        }
        if (tagRows.length >= BATCH || langRows.length >= BATCH) await flush();
    }
    await flush();

    const [[c]] = await sql.query(
        "SELECT (SELECT COUNT(*) FROM game_tag) AS game_tag, (SELECT COUNT(*) FROM game_language) AS game_language");
    console.log(`MongoDB links: ${nTag} tag, ${nLang} language (${skipped} games not in bench skipped)`);
    console.log(`MySQL rows:    ${c.game_tag} game_tag, ${c.game_language} game_language`);
    console.log("Differences, if any, are names MySQL's case-insensitive collation treats as equal.");
    await sql.end();
}

main()
    .catch((err) => { console.error("Fill failed:", err.message); process.exitCode = 1; })
    .finally(() => process.exit());
