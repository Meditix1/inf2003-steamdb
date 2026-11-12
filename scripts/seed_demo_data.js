#!/usr/bin/env node
// =========================================================
// Seeds demo users (MySQL) and their game collections (MongoDB)
// for the live site.
//
// Usage, from ~/steamdb-web:
//   node scripts/seed_demo_data.js                  # 100 users
//   node scripts/seed_demo_data.js --users 200 --seed 2003
//   node scripts/seed_demo_data.js --remove         # delete all demo data
//
// Demo users are recognised by their email domain, @demo.steamdb.local.
// Re-running first removes the previous demo users and their collections,
// so it never duplicates data. Real accounts are never touched.
// All demo users share one password, printed at the end.
// =========================================================

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const bcrypt = require("bcrypt");
const mysql = require("../db/mysql");
const { connectMongo, getMongoDB } = require("../db/mongodb");
const { makeRng, makeUsers, makeCollectionsForUser, loadThemePools } = require("./lib/demo_collections");

const DEMO_DOMAIN = "demo.steamdb.local";
const DEMO_PASSWORD = "demo-password-2026";

function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function removeDemoData(collections) {
    const [rows] = await mysql.query(
        "SELECT user_id FROM users WHERE email LIKE ?", [`%@${DEMO_DOMAIN}`]
    );
    const ids = rows.map((r) => r.user_id);

    // MongoDB first: user_id there is a reference, not a foreign key,
    // so MySQL's ON DELETE CASCADE can't remove these documents for us.
    const { deletedCount } = ids.length
        ? await collections.deleteMany({ user_id: { $in: ids } })
        : { deletedCount: 0 };

    // Their reviews first: review.user_id is ON DELETE SET NULL, which would keep them as anonymous
    if (ids.length) await mysql.query("DELETE FROM review WHERE user_id IN (?)", [ids]);
    // MySQL: cascades to the demo users' library, wishlist, votes and quiz rows
    const [result] = await mysql.query("DELETE FROM users WHERE email LIKE ?", [`%@${DEMO_DOMAIN}`]);

    return { users: result.affectedRows, collections: deletedCount };
}

// Library, wishlist, reviews and helpful votes, so the community rankings and
// review pages have realistic data. Games come from the same themed pools.
const REVIEW_TEXT = {
    1: ["Couldn't get into it at all.", "Not for me. Refunded after an hour."],
    2: ["Some good ideas, but it drags.", "Fun for a bit, then repetitive."],
    3: ["Decent. Worth it on sale.", "Solid, nothing special."],
    4: ["Really enjoyed this one.", "Great with friends, a few rough edges.", "Easy to recommend."],
    5: ["One of my favourites.", "Brilliant from start to finish.", "Lost a whole weekend to this."]
};
const RATING_WEIGHTS = [0.05, 0.08, 0.17, 0.35, 0.35];

async function seedActivity(users, idByEmail, pools, rng) {
    const pick = (arr) => arr[Math.floor(Math.pow(rng(), 2) * arr.length)];   // popular games more often
    const allIds = [...new Set(pools.flatMap((p) => p.ids))];
    const library = [], wishlist = [], reviews = [];

    for (const u of users) {
        const userId = idByEmail.get(u.email);
        const owned = new Set();
        const nOwned = 3 + Math.floor(rng() * 13);
        for (let g = 0; g < nOwned * 3 && owned.size < nOwned; g++) owned.add(pick(allIds));
        const wanted = new Set();
        const nWanted = 2 + Math.floor(rng() * 7);
        for (let g = 0; g < nWanted * 3 && wanted.size < nWanted; g++) {
            const id = pick(allIds);
            if (!owned.has(id)) wanted.add(id);
        }
        const day = 86400000;
        const END = Date.UTC(2026, 10, 1);                       // no dates after 1 Nov 2026
        const at = (t) => new Date(Math.min(t, END));
        for (const id of owned) {
            const added = at(u.created_at.getTime() + Math.floor(rng() * 200) * day);
            library.push([userId, Number(id), added]);
            if (rng() < 0.4) {
                let r = rng(), rating = 1;
                while (rating < 5 && (r -= RATING_WEIGHTS[rating - 1]) > 0) rating++;
                const texts = REVIEW_TEXT[rating];
                reviews.push([userId, Number(id), rating, texts[Math.floor(rng() * texts.length)],
                    at(added.getTime() + Math.floor(rng() * 30) * day)]);
            }
        }
        for (const id of wanted) {
            wishlist.push([userId, Number(id), at(u.created_at.getTime() + Math.floor(rng() * 200) * day),
                null, Math.floor(rng() * 4)]);
        }
    }

    await mysql.query("INSERT INTO library (user_id, game_id, added_at) VALUES ?", [library]);
    await mysql.query("INSERT INTO wishlist (user_id, game_id, added_at, notes, priority) VALUES ?", [wishlist]);
    if (reviews.length) await mysql.query("INSERT INTO review (user_id, game_id, rating, body, created_at) VALUES ?", [reviews]);

    // Helpful votes from other demo users (never the author: a trigger enforces that too)
    const userIds = [...idByEmail.values()];
    const [saved] = await mysql.query(
        "SELECT review_id, user_id FROM review WHERE user_id IN (?)", [userIds]);
    const votes = [];
    for (const r of saved) {
        const voters = new Set();
        const n = Math.floor(Math.pow(rng(), 2) * 8);
        for (let k = 0; k < n * 3 && voters.size < n; k++) {
            const v = userIds[Math.floor(rng() * userIds.length)];
            if (v !== r.user_id) voters.add(v);
        }
        for (const v of voters) votes.push([r.review_id, v, rng() < 0.8 ? "helpful" : "unhelpful"]);
    }
    if (votes.length) await mysql.query("INSERT INTO review_vote (review_id, user_id, vote_type) VALUES ?", [votes]);

    console.log(`Created ${library.length} library entries, ${wishlist.length} wishlist entries, ` +
                `${reviews.length} reviews and ${votes.length} helpful votes in MySQL`);
}

async function main() {
    const userCount = Number(arg("users", 100));
    const seed = Number(arg("seed", 2003));
    if (!Number.isInteger(userCount) || userCount < 1 || userCount > 1000) {
        throw new Error("--users must be between 1 and 1000");
    }

    await connectMongo();
    const mongo = getMongoDB();
    const collections = mongo.collection("collections");

    const removed = await removeDemoData(collections);
    console.log(`Removed previous demo data: ${removed.users} users, ${removed.collections} collections`);
    if (process.argv.includes("--remove")) return;

    // ---- Users (MySQL) ----
    const rng = makeRng(seed);
    const users = makeUsers(userCount, rng);
    const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);   // hashed once, shared by all demo users

    await mysql.query(
        "INSERT INTO users (username, email, password_hash, created_at) VALUES ?",
        [users.map((u) => [u.username, u.email, passwordHash, u.created_at])]
    );
    const [rows] = await mysql.query(
        "SELECT user_id, email FROM users WHERE email LIKE ?", [`%@${DEMO_DOMAIN}`]
    );
    const idByEmail = new Map(rows.map((r) => [r.email, r.user_id]));
    console.log(`Created ${rows.length} demo users in MySQL`);

    // ---- Collections (MongoDB) ----
    console.log("Reading theme pools from the games collection (this scans games, may take a moment)...");
    const pools = await loadThemePools(mongo.collection("games"));
    console.log(`  ${pools.length} themes have enough matching games`);

    const docs = users.flatMap((u) =>
        makeCollectionsForUser(idByEmail.get(u.email), u.created_at, pools, rng)
    );

    if (docs.length) {
        await collections.insertMany(docs, { ordered: false });
    }

    const items = docs.reduce((n, d) => n + d.games.length, 0);
    console.log(`Created ${docs.length} collections holding ${items} games in MongoDB`);
    console.log(`  average ${(docs.length / users.length).toFixed(2)} collections per user, ` +
                `${docs.length ? (items / docs.length).toFixed(1) : 0} games per collection`);

    await seedActivity(users, idByEmail, pools, rng);

    console.log("\nLog in as any demo user, for example:");
    console.log(`  email:    ${users[0].email}`);
    console.log(`  password: ${DEMO_PASSWORD}`);
}

main()
    .catch((err) => { console.error("Seeding failed:", err.message); process.exitCode = 1; })
    .finally(async () => {
        await mysql.end().catch(() => {});
        process.exit();
    });
