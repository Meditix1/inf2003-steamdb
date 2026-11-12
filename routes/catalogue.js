// =========================================================
// /api/catalogue?ids=1,2,3 — basic game details from MongoDB by id.
// Used by the game page and anywhere else that only has ids.
// =========================================================

const express = require("express");
const { handle, parseIdList } = require("../lib/http");
const { getGameCards, fallbackCard } = require("../lib/catalogue");

const router = express.Router();

router.get("/", handle(async (req, res) => {
    const ids = parseIdList(req.query.ids, 100);
    const cards = await getGameCards(ids, { strict: true });
    res.json(ids.map((id) => cards.get(id) || { ...fallbackCard(id), missing: true }));
}));

module.exports = router;
