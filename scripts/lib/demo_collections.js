// =========================================================
// Shared generator for demo users and their game collections.
//
// Used by:
//   scripts/seed_demo_data.js          -> the live site (MySQL users + MongoDB collections)
//   scripts/build_bench_collections.js -> the benchmark copies (MySQL, MongoDB embedded, MongoDB referenced)
//
// Deterministic: the same --seed always produces the same users, collections
// and games, so the benchmark data can be rebuilt exactly and cited in the report.
// Collections are themed ("Couch co-op night", "Horror marathon", ...) and filled
// from games that really match the theme, popular games picked more often.
// =========================================================

// Small seeded random number generator (mulberry32): returns 0 <= x < 1
function makeRng(seed) {
    let a = seed >>> 0;
    return function rng() {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Fixed window so reruns give identical dates (not tied to "now")
const WINDOW_START = Date.UTC(2025, 10, 1);   // 1 Nov 2025
const WINDOW_END = Date.UTC(2026, 10, 1);     // 1 Nov 2026

// Theme -> MongoDB filter on the raw Kaggle fields in `games`.
// tags is an object { "Cozy": 120, ... } or [] for untagged games,
// so "has tag X" is { "tags.X": { $exists: true } }.
const has = (tag) => ({ [`tags.${tag}`]: { $exists: true } });

const THEMES = [
    { name: "Couch co-op night",  filter: { categories: { $in: ["Shared/Split Screen Co-op", "Shared/Split Screen"] } } },
    { name: "Online with friends", filter: { categories: "Online Co-op" } },
    { name: "Cozy weekend",       filter: has("Cozy") },
    { name: "Roguelike runs",     filter: { $or: [has("Roguelike"), has("Roguelite")] } },
    { name: "Horror marathon",    filter: has("Horror") },
    { name: "Story-rich picks",   filter: has("Story Rich") },
    { name: "Free to play",       filter: { price: 0 } },
    { name: "Strategy backlog",   filter: { genres: "Strategy" } },
    { name: "RPGs to finish",     filter: { genres: "RPG" } },
    { name: "Indie gems",         filter: { genres: "Indie" } },
    { name: "Racing",             filter: { genres: "Racing" } },
    { name: "Sports nights",      filter: { genres: "Sports" } },
    { name: "Puzzle breaks",      filter: has("Puzzle") },
    { name: "Open worlds",        filter: has("Open World") },
    { name: "Plays on my Mac",    filter: { mac: true } },
    { name: "Pixel art",          filter: has("Pixel Graphics") },
    { name: "Simulation",         filter: { genres: "Simulation" } },
    { name: "Short games",        filter: has("Short") }
];

const POOL_SIZE = 300;      // most-reviewed matching games per theme
const MIN_POOL = 5;         // themes with fewer matching games are skipped

// How many collections a user has: 0..5, most people have 1-2
const COLLECTIONS_PER_USER = [0.15, 0.30, 0.25, 0.15, 0.10, 0.05];

// Read the candidate games for each theme from MongoDB.
// `allowedIds` (optional Set of numeric app ids) keeps only games that also
// exist somewhere else, e.g. in the MySQL benchmark table.
async function loadThemePools(gamesCollection, { allowedIds = null } = {}) {
    const pools = [];
    for (const theme of THEMES) {
        const docs = await gamesCollection
            .find(theme.filter, { projection: { _id: 1 } })
            .sort({ positive: -1, _id: 1 })
            .limit(POOL_SIZE)
            .toArray();

        const ids = docs
            .map((d) => String(d._id))
            .filter((id) => /^\d+$/.test(id))
            .filter((id) => !allowedIds || allowedIds.has(Number(id)));

        if (ids.length >= MIN_POOL) pools.push({ name: theme.name, ids });
    }
    return pools;
}

function pickWeighted(rng, weights) {
    let r = rng();
    for (let i = 0; i < weights.length; i++) {
        r -= weights[i];
        if (r < 0) return i;
    }
    return weights.length - 1;
}

function randomDate(rng, from, to) {
    return new Date(from + Math.floor(rng() * Math.max(1, to - from)));
}

// Users: deterministic usernames like "pixel_fox_007"
const ADJECTIVES = ["pixel", "cozy", "rapid", "silent", "lucky", "brave", "retro", "cosmic", "mellow", "crimson", "frosty", "sunny"];
const NOUNS = ["fox", "otter", "golem", "ranger", "wizard", "panda", "comet", "knight", "raven", "falcon", "slime", "dragon"];

function makeUsers(count, rng) {
    const users = [];
    for (let i = 1; i <= count; i++) {
        const adj = ADJECTIVES[Math.floor(rng() * ADJECTIVES.length)];
        const noun = NOUNS[Math.floor(rng() * NOUNS.length)];
        const username = `${adj}_${noun}_${String(i).padStart(3, "0")}`;
        users.push({
            index: i,
            username,
            email: `${username}@demo.steamdb.local`,
            created_at: randomDate(rng, WINDOW_START, WINDOW_START + (WINDOW_END - WINDOW_START) * 0.6)
        });
    }
    return users;
}

// Collections for one user. Returns documents in the live MongoDB shape:
// { user_id, name, created_at, updated_at, games: [{ app_id: "413150", added_at }] }
function makeCollectionsForUser(userId, userCreatedAt, pools, rng) {
    const count = Math.min(pickWeighted(rng, COLLECTIONS_PER_USER), pools.length);

    // Distinct themes per user, so names are unique per user
    const themeOrder = pools.map((p, i) => [rng(), i]).sort((a, b) => a[0] - b[0]).map(([, i]) => i);

    const collections = [];
    for (let c = 0; c < count; c++) {
        const pool = pools[themeOrder[c]];
        const created = randomDate(rng, userCreatedAt.getTime(), WINDOW_END - 86400000);

        // 3-24 games, skewed towards smaller lists
        const size = Math.min(pool.ids.length, 3 + Math.floor(Math.pow(rng(), 1.5) * 22));

        // Popular games (front of the pool) are picked more often
        const chosen = new Set();
        let guard = 0;
        while (chosen.size < size && guard++ < size * 50) {
            chosen.add(pool.ids[Math.floor(Math.pow(rng(), 2) * pool.ids.length)]);
        }

        let t = created.getTime();
        const games = [...chosen].map((appId) => {
            t += Math.floor(rng() * 5 * 86400000);              // 0-5 days between additions
            return { app_id: appId, added_at: new Date(Math.min(t, WINDOW_END)) };
        });

        collections.push({
            user_id: userId,
            name: pool.name,
            created_at: created,
            updated_at: games.length ? games[games.length - 1].added_at : created,
            games
        });
    }
    return collections;
}

module.exports = { makeRng, makeUsers, makeCollectionsForUser, loadThemePools, THEMES };
