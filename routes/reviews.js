// =========================================================
// /api/reviews — reviews, helpful votes and reports
// =========================================================

const express = require("express");
const mysql = require("../db/mysql");
const { sessionUserId, requireLogin } = require("../middleware/auth");
const { handle, HttpError, parseId } = require("../lib/http");
const { withGameCards } = require("../lib/catalogue");

const router = express.Router();

const PAGE_SIZE = 10;

const SORTS = {
    helpful: "score DESC, r.created_at DESC",
    newest: "r.created_at DESC",
    highest: "r.rating DESC, r.created_at DESC",
    lowest: "r.rating ASC, r.created_at DESC"
};

function parseRating(value, required) {
    if (value === undefined && !required) return undefined;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 5) throw new HttpError(400, "Rating must be 1 to 5 stars");
    return n;
}

function parseBody(value) {
    if (value === undefined) return undefined;
    const s = String(value ?? "").trim();
    if (s.length > 8000) throw new HttpError(400, "Review can be at most 8,000 characters");
    return s || null;
}

// The review must exist and be visible; returns its author
async function activeReview(reviewId) {
    const [[review]] = await mysql.query(
        "SELECT review_id, user_id FROM review WHERE review_id = ? AND status = 'active'", [reviewId]
    );
    if (!review) throw new HttpError(404, "Review not found");
    return review;
}


// GET /api/reviews/game/:gameId?sort=helpful|newest|highest|lowest&page=1
// Public. Logged-in users also see their own vote on each review.
router.get("/game/:gameId", handle(async (req, res) => {
    const gameId = parseId(req.params.gameId, "game id");
    const viewerId = sessionUserId(req);
    const orderBy = SORTS[req.query.sort] || SORTS.helpful;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);

    // Summary: count, average and the 1-5 star distribution
    const [[summary]] = await mysql.query(`
        SELECT COUNT(*) AS count,
               ROUND(AVG(rating), 2) AS average,
               SUM(rating = 1) AS s1, SUM(rating = 2) AS s2, SUM(rating = 3) AS s3,
               SUM(rating = 4) AS s4, SUM(rating = 5) AS s5
        FROM review
        WHERE game_id = ? AND status = 'active'
    `, [gameId]);

    const [reviews] = await mysql.query(`
        SELECT r.review_id, r.rating, r.body, r.created_at, r.updated_at,
               (r.user_id = ?)            AS is_mine,
               CASE WHEN u.is_deleted = 1 THEN NULL ELSE u.username END AS username,
               (l.user_id IS NOT NULL)    AS author_owns_game,
               COALESCE(SUM(v.vote_type = 'helpful'), 0)   AS helpful,
               COALESCE(SUM(v.vote_type = 'unhelpful'), 0) AS unhelpful,
               COALESCE(SUM(v.vote_type = 'helpful'), 0)
                 - COALESCE(SUM(v.vote_type = 'unhelpful'), 0) AS score,
               MAX(CASE WHEN v.user_id = ? THEN v.vote_type END) AS my_vote
        FROM review r
        LEFT JOIN users u        ON u.user_id = r.user_id
        LEFT JOIN library l      ON l.user_id = r.user_id AND l.game_id = r.game_id
        LEFT JOIN review_vote v  ON v.review_id = r.review_id
        WHERE r.game_id = ? AND r.status = 'active'
        GROUP BY r.review_id, u.user_id, l.user_id
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?
    `, [viewerId, viewerId, gameId, PAGE_SIZE, (page - 1) * PAGE_SIZE]);

    res.json({
        summary: {
            count: summary.count,
            average: summary.average === null ? null : Number(summary.average),
            distribution: [1, 2, 3, 4, 5].map((s) => Number(summary[`s${s}`]) || 0)
        },
        page,
        pageSize: PAGE_SIZE,
        reviews: reviews.map((r) => ({
            review_id: r.review_id,
            rating: r.rating,
            body: r.body,
            created_at: r.created_at,
            updated_at: r.updated_at,
            username: r.username ?? "[deleted user]",
            is_mine: Boolean(r.is_mine),
            author_owns_game: Boolean(r.author_owns_game),
            helpful: Number(r.helpful),
            unhelpful: Number(r.unhelpful),
            my_vote: r.my_vote
        }))
    });
}));


// GET /api/reviews/mine — my reviews on every game, including hidden ones
router.get("/mine", requireLogin, handle(async (req, res) => {
    const [rows] = await mysql.query(`
        SELECT r.review_id, r.game_id, r.rating, r.body, r.status, r.created_at, r.updated_at,
               COALESCE(SUM(v.vote_type = 'helpful'), 0)   AS helpful,
               COALESCE(SUM(v.vote_type = 'unhelpful'), 0) AS unhelpful
        FROM review r
        LEFT JOIN review_vote v ON v.review_id = r.review_id
        WHERE r.user_id = ?
        GROUP BY r.review_id
        ORDER BY r.created_at DESC
    `, [req.userId]);

    res.json(await withGameCards(rows.map((r) => ({
        ...r, helpful: Number(r.helpful), unhelpful: Number(r.unhelpful)
    }))));
}));


// POST /api/reviews/game/:gameId  { rating, body }
router.post("/game/:gameId", requireLogin, handle(async (req, res) => {
    const gameId = parseId(req.params.gameId, "game id");
    const rating = parseRating(req.body?.rating, true);
    const body = parseBody(req.body?.body) ?? null;

    try {
        const [result] = await mysql.query(
            "INSERT INTO review (user_id, game_id, rating, body) VALUES (?, ?, ?, ?)",
            [req.userId, gameId, rating, body]
        );
        res.status(201).json({ review_id: result.insertId });
    } catch (err) {
        // UNIQUE (user_id, game_id): one review per user per game
        if (err.code === "ER_DUP_ENTRY") {
            throw new HttpError(409, "You've already reviewed this game. Edit your review instead.");
        }
        throw err;
    }
}));


// PATCH /api/reviews/:reviewId  { rating?, body? } — author only
router.patch("/:reviewId", requireLogin, handle(async (req, res) => {
    const reviewId = parseId(req.params.reviewId, "review id");
    const rating = parseRating(req.body?.rating, false);
    const body = parseBody(req.body?.body);

    const sets = [];
    const params = [];
    if (rating !== undefined) { sets.push("rating = ?"); params.push(rating); }
    if (body !== undefined)   { sets.push("body = ?");   params.push(body); }
    if (!sets.length) throw new HttpError(400, "Nothing to update");

    // A moderator's decision stands: edits don't bring back a hidden or removed review
    const [result] = await mysql.query(
        `UPDATE review SET ${sets.join(", ")} WHERE review_id = ? AND user_id = ?`,
        [...params, reviewId, req.userId]
    );
    if (!result.affectedRows) throw new HttpError(404, "Review not found");

    res.json({ updated: true });
}));


// DELETE /api/reviews/:reviewId — author only (votes and reports cascade)
router.delete("/:reviewId", requireLogin, handle(async (req, res) => {
    const reviewId = parseId(req.params.reviewId, "review id");

    const [result] = await mysql.query(
        "DELETE FROM review WHERE review_id = ? AND user_id = ?", [reviewId, req.userId]
    );
    if (!result.affectedRows) throw new HttpError(404, "Review not found");

    res.json({ removed: true });
}));


// PUT /api/reviews/:reviewId/vote  { vote: "helpful" | "unhelpful" | null }
// Changing your vote overwrites it (PRIMARY KEY (review_id, user_id)); null removes it.
router.put("/:reviewId/vote", requireLogin, handle(async (req, res) => {
    const reviewId = parseId(req.params.reviewId, "review id");
    const vote = req.body?.vote ?? null;
    if (vote !== null && vote !== "helpful" && vote !== "unhelpful") {
        throw new HttpError(400, "vote must be helpful, unhelpful or null");
    }

    const review = await activeReview(reviewId);
    if (review.user_id === req.userId) throw new HttpError(403, "You can't vote on your own review");

    if (vote === null) {
        await mysql.query(
            "DELETE FROM review_vote WHERE review_id = ? AND user_id = ?", [reviewId, req.userId]
        );
    } else {
        await mysql.query(`
            INSERT INTO review_vote (review_id, user_id, vote_type) VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE vote_type = ?, voted_at = CURRENT_TIMESTAMP
        `, [reviewId, req.userId, vote, vote]);
    }

    const [[counts]] = await mysql.query(`
        SELECT COALESCE(SUM(vote_type = 'helpful'), 0)   AS helpful,
               COALESCE(SUM(vote_type = 'unhelpful'), 0) AS unhelpful
        FROM review_vote WHERE review_id = ?
    `, [reviewId]);

    res.json({ my_vote: vote, helpful: Number(counts.helpful), unhelpful: Number(counts.unhelpful) });
}));


// POST /api/reviews/:reviewId/flag  { reason }
const REASONS = ["Spam", "Offensive or abusive", "Off-topic", "Spoilers", "Other"];

router.post("/:reviewId/flag", requireLogin, handle(async (req, res) => {
    const reviewId = parseId(req.params.reviewId, "review id");
    const reason = String(req.body?.reason ?? "").trim();
    if (!REASONS.includes(reason)) throw new HttpError(400, `Reason must be one of: ${REASONS.join(", ")}`);

    const review = await activeReview(reviewId);
    if (review.user_id === req.userId) throw new HttpError(403, "You can't report your own review");

    try {
        await mysql.query(
            "INSERT INTO flag_report (reporter_id, review_id, reason) VALUES (?, ?, ?)",
            [req.userId, reviewId, reason]
        );
    } catch (err) {
        // UNIQUE (reporter_id, review_id)
        if (err.code === "ER_DUP_ENTRY") throw new HttpError(409, "You've already reported this review");
        throw err;
    }

    res.status(201).json({ reported: true });
}));


module.exports = router;
module.exports.REASONS = REASONS;
