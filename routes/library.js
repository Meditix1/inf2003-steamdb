// =========================================================
// /api/library — games the user owns
// =========================================================

const express = require("express");
const mysql = require("../db/mysql");
const { requireLogin } = require("../middleware/auth");
const { handle, parseId, inTransaction } = require("../lib/http");
const { withGameCards } = require("../lib/catalogue");

const router = express.Router();
router.use(requireLogin);


// GET /api/library?sort=recent|name
router.get("/", handle(async (req, res) => {
    const [rows] = await mysql.query(`
        SELECT l.game_id, l.added_at,
               (r.review_id IS NOT NULL) AS reviewed
        FROM library l
        LEFT JOIN review r ON r.user_id = l.user_id AND r.game_id = l.game_id
        WHERE l.user_id = ?
        ORDER BY l.added_at DESC, l.game_id
    `, [req.userId]);

    const games = await withGameCards(rows.map((r) => ({ ...r, reviewed: Boolean(r.reviewed) })));

    // Titles live in MongoDB, so sorting by name happens after the merge
    if (req.query.sort === "name") {
        games.sort((a, b) => a.game.name.localeCompare(b.game.name));
    }

    res.json({ total: games.length, games });
}));


// POST /api/library/:gameId
// Adding a game you own also takes it off your wishlist. Both changes
// happen in one transaction, so a game is never in both lists.
router.post("/:gameId", handle(async (req, res) => {
    const gameId = parseId(req.params.gameId, "game id");

    const result = await inTransaction(mysql, async (conn) => {
        // Not INSERT IGNORE: that would also silence the FK error for a game that doesn't exist
        let added = true;
        try {
            await conn.query(
                "INSERT INTO library (user_id, game_id) VALUES (?, ?)", [req.userId, gameId]
            );
        } catch (err) {
            if (err.code !== "ER_DUP_ENTRY") throw err;   // already owned: not an error
            added = false;
        }

        const [removed] = await conn.query(
            "DELETE FROM wishlist WHERE user_id = ? AND game_id = ?", [req.userId, gameId]
        );
        return { added, removedFromWishlist: removed.affectedRows === 1 };
    });

    res.status(result.added ? 201 : 200).json(result);
}));


// DELETE /api/library/:gameId
router.delete("/:gameId", handle(async (req, res) => {
    const gameId = parseId(req.params.gameId, "game id");

    const [result] = await mysql.query(
        "DELETE FROM library WHERE user_id = ? AND game_id = ?", [req.userId, gameId]
    );
    if (!result.affectedRows) return res.status(404).json({ message: "Not in your library" });

    res.json({ removed: true });
}));


module.exports = router;
