// =========================================================
// /api/collections — user-made, ordered lists of games (MongoDB)
//
// One document per collection, games embedded in display order:
//   { _id, user_id, name, created_at, updated_at,
//     games: [{ app_id: "413150", added_at }, ...] }
//
// user_id is the MySQL users.user_id. It's a reference, not a foreign key,
// so every query is scoped to the logged-in owner, and account deletion
// must also delete that user's documents here.
// =========================================================

const express = require("express");
const { ObjectId } = require("mongodb");
const { getMongoDB } = require("../db/mongodb");
const { requireLogin } = require("../middleware/auth");
const { handle, HttpError, parseId } = require("../lib/http");
const { toCard, fallbackCard, CARD_FIELDS } = require("../lib/catalogue");

const router = express.Router();
router.use(requireLogin);

// Keeps each document small and bounded (an unbounded array is a MongoDB anti-pattern).
// The validator in scripts/setup enforces the same limit.
const MAX_GAMES = 500;

function db() {
    const d = getMongoDB();
    if (!d) throw new Error("MongoDB is not connected");
    return d;
}
const collections = () => db().collection("collections");
const games = () => db().collection("games");

// 404 (not 403) for a malformed or someone else's id, so ids can't be probed
function parseCollectionId(value) {
    if (typeof value !== "string" || !/^[a-f0-9]{24}$/i.test(value)) {
        throw new HttpError(404, "Collection not found");
    }
    return new ObjectId(value);
}

function parseName(value) {
    const s = String(value ?? "").replace(/\s+/g, " ").trim();
    if (!s) throw new HttpError(400, "Give the collection a name");
    if (s.length > 150) throw new HttpError(400, "Name can be at most 150 characters");
    return s;
}

// 11000 = duplicate key on the unique { user_id, name } index (case-insensitive)
// 121   = document failed the collection's $jsonSchema validator
function mongoError(err) {
    if (err?.code === 11000) throw new HttpError(409, "You already have a collection with that name");
    if (err?.code === 121) throw new HttpError(400, "That change isn't allowed");
    throw err;
}

async function ownCollection(id, userId, projection = { name: 1, created_at: 1, games: 1 }) {
    const doc = await collections().findOne({ _id: id, user_id: userId }, { projection });
    if (!doc) throw new HttpError(404, "Collection not found");
    return doc;
}


// GET /api/collections — my collections with counts and up to 4 cover images.
// One aggregation: count and first 4 ids per document, then one $lookup into games.
router.get("/", handle(async (req, res) => {
    const rows = await collections().aggregate([
        { $match: { user_id: req.userId } },
        { $sort: { created_at: -1 } },
        { $project: {
            name: 1,
            created_at: 1,
            game_count: { $size: "$games" },
            firstIds: { $slice: ["$games.app_id", 4] }
        } },
        { $lookup: {
            from: "games",
            localField: "firstIds",
            foreignField: "_id",
            pipeline: [{ $project: { header_image: 1 } }],
            as: "coverDocs"
        } }
    ]).toArray();

    res.json(rows.map((c) => {
        // $lookup doesn't keep array order, so put covers back in collection order
        const images = new Map(c.coverDocs.map((g) => [String(g._id), g.header_image]));
        return {
            collection_id: c._id.toHexString(),
            name: c.name,
            created_at: c.created_at,
            game_count: c.game_count,
            covers: c.firstIds.map((id) => images.get(id)).filter(Boolean)
        };
    }));
}));


// POST /api/collections  { name }
router.post("/", handle(async (req, res) => {
    const name = parseName(req.body?.name);
    const now = new Date();

    const result = await collections().insertOne(
        { user_id: req.userId, name, created_at: now, updated_at: now, games: [] }
    ).catch(mongoError);

    res.status(201).json({ collection_id: result.insertedId.toHexString(), name });
}));


// GET /api/collections/:id — one collection with its games in order,
// joined to the catalogue with $lookup (both live in MongoDB)
router.get("/:id", handle(async (req, res) => {
    const id = parseCollectionId(req.params.id);

    const [doc] = await collections().aggregate([
        { $match: { _id: id, user_id: req.userId } },
        { $lookup: {
            from: "games",
            localField: "games.app_id",
            foreignField: "_id",
            pipeline: [{ $project: CARD_FIELDS }],
            as: "gameDocs"
        } }
    ]).toArray();

    if (!doc) throw new HttpError(404, "Collection not found");

    const cards = new Map(doc.gameDocs.map((g) => [String(g._id), toCard(g)]));

    res.json({
        collection_id: doc._id.toHexString(),
        name: doc.name,
        created_at: doc.created_at,
        games: doc.games.map((g, index) => ({
            game_id: Number(g.app_id),
            position: index + 1,
            added_at: g.added_at,
            game: cards.get(g.app_id) || fallbackCard(Number(g.app_id))
        }))
    });
}));


// PATCH /api/collections/:id  { name }
router.patch("/:id", handle(async (req, res) => {
    const id = parseCollectionId(req.params.id);
    const name = parseName(req.body?.name);

    const result = await collections().updateOne(
        { _id: id, user_id: req.userId },
        { $set: { name, updated_at: new Date() } }
    ).catch(mongoError);
    if (!result.matchedCount) throw new HttpError(404, "Collection not found");

    res.json({ updated: true });
}));


// DELETE /api/collections/:id — its games go with it (they're embedded)
router.delete("/:id", handle(async (req, res) => {
    const id = parseCollectionId(req.params.id);

    const result = await collections().deleteOne({ _id: id, user_id: req.userId });
    if (!result.deletedCount) throw new HttpError(404, "Collection not found");

    res.json({ removed: true });
}));


// POST /api/collections/:id/games  { gameId } — appended at the end.
// One conditional update: only matches if the game isn't already there and
// the list isn't full, so two quick clicks can't add the same game twice.
router.post("/:id/games", handle(async (req, res) => {
    const id = parseCollectionId(req.params.id);
    const appId = String(parseId(req.body?.gameId, "game id"));

    // No foreign key across documents: check the game exists in the catalogue
    const game = await games().findOne({ _id: appId }, { projection: { _id: 1 } });
    if (!game) throw new HttpError(404, "Game not found");

    const now = new Date();
    const result = await collections().updateOne(
        {
            _id: id,
            user_id: req.userId,
            "games.app_id": { $ne: appId },
            [`games.${MAX_GAMES - 1}`]: { $exists: false }
        },
        { $push: { games: { app_id: appId, added_at: now } }, $set: { updated_at: now } }
    ).catch(mongoError);

    if (!result.matchedCount) {
        const doc = await ownCollection(id, req.userId, { games: 1 });
        if (doc.games.some((g) => g.app_id === appId)) throw new HttpError(409, "Already in this collection");
        throw new HttpError(409, `A collection can hold at most ${MAX_GAMES} games`);
    }

    res.status(201).json({ added: true });
}));


// DELETE /api/collections/:id/games/:gameId
router.delete("/:id/games/:gameId", handle(async (req, res) => {
    const id = parseCollectionId(req.params.id);
    const appId = String(parseId(req.params.gameId, "game id"));

    const result = await collections().updateOne(
        { _id: id, user_id: req.userId, "games.app_id": appId },
        { $pull: { games: { app_id: appId } }, $set: { updated_at: new Date() } }
    );

    if (!result.matchedCount) {
        await ownCollection(id, req.userId, { _id: 1 });   // 404 if the collection itself is missing
        throw new HttpError(404, "Not in this collection");
    }

    res.json({ removed: true });
}));


// PUT /api/collections/:id/order  { gameIds: [30, 10, 20] }
// The new order is written in ONE update of one document, which MongoDB
// applies atomically, so no transaction is needed (MySQL needed one).
// Optimistic concurrency: the update only matches if the list is still exactly
// what we read, so a change made in between isn't silently overwritten.
router.put("/:id/order", handle(async (req, res) => {
    const id = parseCollectionId(req.params.id);
    if (!Array.isArray(req.body?.gameIds)) throw new HttpError(400, "gameIds must be a list");
    const order = req.body.gameIds.map((g) => String(parseId(g, "game id")));

    const doc = await ownCollection(id, req.userId, { games: 1 });
    const byId = new Map(doc.games.map((g) => [g.app_id, g]));

    const sameGames = order.length === byId.size
        && new Set(order).size === order.length
        && order.every((g) => byId.has(g));
    if (!sameGames) throw new HttpError(400, "The list must contain exactly the games in this collection");

    const result = await collections().updateOne(
        { _id: id, user_id: req.userId, games: doc.games },
        { $set: { games: order.map((g) => byId.get(g)), updated_at: new Date() } }
    );
    if (!result.matchedCount) throw new HttpError(409, "This collection changed meanwhile. Reload and try again");

    res.json({ updated: true });
}));


module.exports = router;
