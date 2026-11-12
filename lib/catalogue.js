// =========================================================
// Game details for the user pages, looked up in MongoDB.
//
// MySQL stores only game ids for library / wishlist / reviews.
// To show titles and images, the page's ids are looked up in
// MongoDB with ONE query: find({ _id: { $in: ids } }).
// =========================================================

const { getMongoDB } = require("../db/mongodb");

function gamesCollection() {
    const db = getMongoDB();
    if (!db) throw new Error("MongoDB is not connected; await connectMongo() before listening");
    return db.collection("games");
}

// Decimal128 (from the plan) or a plain number -> plain number for JSON
function toNumber(value) {
    if (value === null || value === undefined) return null;
    const n = Number(typeof value === "object" ? value.toString() : value);
    return Number.isFinite(n) ? n : null;
}

const CARD_FIELDS = {
    title: 1, name: 1, header_image: 1, price: 1, release_date: 1,
    short_description: 1, genres: 1, "reviews.score": 1
};

function toCard(doc) {
    return {
        app_id: Number(doc._id),
        name: doc.title ?? doc.name ?? `Game ${doc._id}`,
        header_image: doc.header_image ?? null,
        price: toNumber(doc.price),
        release_date: doc.release_date ?? null,
        short_description: doc.short_description ?? null,
        genres: Array.isArray(doc.genres) ? doc.genres : []
    };
}

// ids -> Map(app_id -> card). Missing games are simply absent from the map.
// Strict lookups let the details endpoint distinguish an outage from a missing game.
async function getGameCards(ids, { strict = false } = {}) {
    const unique = [...new Set(ids.map(Number))]
        .filter((id) => Number.isInteger(id) && id > 0 && id <= 2147483647);
    if (!unique.length) return new Map();

    try {
        const games = await gamesCollection();
        const docs = await games.find(
            // The importer stores Steam IDs as strings; API/MySQL IDs stay numeric.
            { _id: { $in: unique.map(String) } },
            { projection: CARD_FIELDS }
        ).toArray();
        return new Map(docs.map((d) => [Number(d._id), toCard(d)]));
    } catch (err) {
        if (strict) throw err;

        // Catalogue being down shouldn't break the user's own pages:
        // they still get their list, just without titles and images.
        console.error("Catalogue lookup failed:", err.message);
        return new Map();
    }
}

// Placeholder when a game id has no catalogue document (yet)
function fallbackCard(appId) {
    return {
        app_id: appId, name: `Game ${appId}`, header_image: null,
        price: null, release_date: null, short_description: null, genres: []
    };
}

// Attach `game` card details to each row that has a game_id
async function withGameCards(rows) {
    const cards = await getGameCards(rows.map((r) => r.game_id));
    return rows.map((r) => ({ ...r, game: cards.get(r.game_id) || fallbackCard(r.game_id) }));
}

module.exports = { getGameCards, withGameCards, fallbackCard, toCard, CARD_FIELDS };
