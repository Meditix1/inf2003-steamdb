// =========================================================
// /api/wishlist — games the user wants, with notes and priority
// =========================================================

const express = require("express");
const mysql = require("../db/mysql");
const { requireLogin } = require("../middleware/auth");
const { handle, HttpError, parseId } = require("../lib/http");
const { withGameCards } = require("../lib/catalogue");

const router = express.Router();
router.use(requireLogin);

// 0 = none, 1 = low, 2 = medium, 3 = high
function parsePriority(value) {
    if (value === undefined) return undefined;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 3) throw new HttpError(400, "Priority must be 0-3");
    return n;
}

function parseNotes(value) {
    if (value === undefined) return undefined;
    if (value === null) return null;
    const s = String(value).trim();
    if (s.length > 500) throw new HttpError(400, "Notes can be at most 500 characters");
    return s || null;
}


// GET /api/wishlist?sort=priority|recent|name|price
router.get("/", handle(async (req, res) => {
    const order = req.query.sort === "recent"
        ? "added_at DESC, game_id"
        : "priority DESC, added_at DESC, game_id";

    const [rows] = await mysql.query(
        `SELECT game_id, added_at, notes, priority FROM wishlist WHERE user_id = ? ORDER BY ${order}`,
        [req.userId]
    );

    const games = await withGameCards(rows);

    // Name and price come from MongoDB, so those sorts happen after the merge
    if (req.query.sort === "name") {
        games.sort((a, b) => a.game.name.localeCompare(b.game.name));
    } else if (req.query.sort === "price") {
        games.sort((a, b) => (a.game.price ?? Infinity) - (b.game.price ?? Infinity));
    }

    res.json({ total: games.length, games });
}));


// POST /api/wishlist/:gameId  { notes?, priority? }
router.post("/:gameId", handle(async (req, res) => {
    const gameId = parseId(req.params.gameId, "game id");
    const notes = parseNotes(req.body?.notes) ?? null;
    const priority = parsePriority(req.body?.priority) ?? 0;

    const [[owned]] = await mysql.query(
        "SELECT 1 AS ok FROM library WHERE user_id = ? AND game_id = ?", [req.userId, gameId]
    );
    if (owned) throw new HttpError(409, "This game is already in your library");

    try {
        await mysql.query(
            "INSERT INTO wishlist (user_id, game_id, notes, priority) VALUES (?, ?, ?, ?)",
            [req.userId, gameId, notes, priority]
        );
    } catch (err) {
        if (err.code === "ER_DUP_ENTRY") throw new HttpError(409, "Already on your wishlist");
        throw err;
    }

    res.status(201).json({ added: true });
}));


// PATCH /api/wishlist/:gameId  { notes?, priority? }
router.patch("/:gameId", handle(async (req, res) => {
    const gameId = parseId(req.params.gameId, "game id");
    const notes = parseNotes(req.body?.notes);
    const priority = parsePriority(req.body?.priority);

    const sets = [];
    const params = [];
    if (notes !== undefined)    { sets.push("notes = ?");    params.push(notes); }
    if (priority !== undefined) { sets.push("priority = ?"); params.push(priority); }
    if (!sets.length) throw new HttpError(400, "Nothing to update");

    const [result] = await mysql.query(
        `UPDATE wishlist SET ${sets.join(", ")} WHERE user_id = ? AND game_id = ?`,
        [...params, req.userId, gameId]
    );
    if (!result.affectedRows) throw new HttpError(404, "Not on your wishlist");

    res.json({ updated: true });
}));


// DELETE /api/wishlist/:gameId
router.delete("/:gameId", handle(async (req, res) => {
    const gameId = parseId(req.params.gameId, "game id");

    const [result] = await mysql.query(
        "DELETE FROM wishlist WHERE user_id = ? AND game_id = ?", [req.userId, gameId]
    );
    if (!result.affectedRows) throw new HttpError(404, "Not on your wishlist");

    res.json({ removed: true });
}));


module.exports = router;
