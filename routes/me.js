// =========================================================
// /api/me — the logged-in user's relationship to games
// =========================================================

const express = require("express");
const mysql = require("../db/mysql");
const { getMongoDB } = require("../db/mongodb");
const { sessionUserId, requireLogin } = require("../middleware/auth");
const { handle, parseId, parseIdList } = require("../lib/http");

const router = express.Router();


// GET /api/me/summary — counts for the profile header
router.get("/summary", requireLogin, handle(async (req, res) => {
    const [[row]] = await mysql.query(`
        SELECT
            u.username,
            u.role,
            u.created_at,
            (SELECT COUNT(*) FROM library    WHERE user_id = u.user_id) AS library,
            (SELECT COUNT(*) FROM wishlist   WHERE user_id = u.user_id) AS wishlist,
            (SELECT COUNT(*) FROM review     WHERE user_id = u.user_id) AS reviews
        FROM users u
        WHERE u.user_id = ?
    `, [req.userId]);

    if (!row) return res.status(404).json({ message: "User not found" });

    // Collections live in MongoDB, keyed by the MySQL user_id
    try {
        row.collections = await getMongoDB().collection("collections").countDocuments({ user_id: req.userId });
    } catch (err) {
        console.error("Collection count failed:", err.message);
        row.collections = null;
    }

    // Moderators also see how many reported reviews are waiting
    if (row.role === "moderator" || row.role === "admin") {
        const [[flags]] = await mysql.query(
            "SELECT COUNT(*) AS n FROM v_moderation_queue"
        );
        row.open_reports = flags.n;
    }

    res.json(row);
}));


// GET /api/me/status?ids=10,20,30
// Which of these games are in my library / wishlist. Used to badge a page
// of game cards from MongoDB with ONE query per table, not one per game.
router.get("/status", handle(async (req, res) => {
    const userId = sessionUserId(req);
    const ids = parseIdList(req.query.ids, 100);

    if (!userId || !ids.length) {
        return res.json({ loggedIn: Boolean(userId), library: [], wishlist: [] });
    }

    const [owned] = await mysql.query(
        "SELECT game_id FROM library WHERE user_id = ? AND game_id IN (?)", [userId, ids]
    );
    const [wished] = await mysql.query(
        "SELECT game_id FROM wishlist WHERE user_id = ? AND game_id IN (?)", [userId, ids]
    );

    res.json({
        loggedIn: true,
        library: owned.map((r) => r.game_id),
        wishlist: wished.map((r) => r.game_id)
    });
}));


// GET /api/me/games/:gameId — everything about me and one game (game page)
router.get("/games/:gameId", handle(async (req, res) => {
    const userId = sessionUserId(req);
    const gameId = parseId(req.params.gameId, "game id");

    if (!userId) return res.json({ loggedIn: false });

    const [[library]] = await mysql.query(
        "SELECT added_at FROM library WHERE user_id = ? AND game_id = ?", [userId, gameId]
    );
    const [[wishlist]] = await mysql.query(
        "SELECT added_at, notes, priority FROM wishlist WHERE user_id = ? AND game_id = ?",
        [userId, gameId]
    );
    const [[review]] = await mysql.query(`
        SELECT review_id, rating, body, status, created_at, updated_at
        FROM review WHERE user_id = ? AND game_id = ?
    `, [userId, gameId]);

    res.json({
        loggedIn: true,
        owned: Boolean(library),
        ownedSince: library?.added_at ?? null,
        wishlist: wishlist || null,
        review: review || null
    });
}));


module.exports = router;
