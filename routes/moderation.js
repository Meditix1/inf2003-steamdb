// =========================================================
// /api/moderation — reported reviews (moderators and admins only)
// =========================================================

const express = require("express");
const mysql = require("../db/mysql");
const { requireRole } = require("../middleware/auth");
const { handle, HttpError, parseId, inTransaction } = require("../lib/http");
const { withGameCards } = require("../lib/catalogue");

const router = express.Router();
router.use(requireRole("moderator", "admin"));


// GET /api/moderation/flags?status=open|resolved|dismissed
// One row per reported review, with how many people reported it and why.
router.get("/flags", handle(async (req, res) => {
    const status = ["open", "resolved", "dismissed"].includes(req.query.status)
        ? req.query.status
        : "open";

    const [rows] = await mysql.query(`
        SELECT r.review_id, r.game_id, r.rating, r.body, r.created_at,
               r.status                    AS review_status,
               CASE WHEN author.is_deleted = 1 THEN NULL ELSE author.username END AS author,
               COUNT(*)                    AS report_count,
               GROUP_CONCAT(DISTINCT f.reason ORDER BY f.reason SEPARATOR ', ') AS reasons,
               MIN(f.created_at)           AS first_reported,
               MAX(f.resolved_at)          AS resolved_at,
               MAX(moderator.username)     AS resolved_by
        FROM flag_report f
        JOIN review r              ON r.review_id = f.review_id
        LEFT JOIN users author     ON author.user_id = r.user_id
        LEFT JOIN users moderator  ON moderator.user_id = f.moderator_id
        WHERE f.status = ?
        GROUP BY r.review_id, author.user_id
        ORDER BY report_count DESC, first_reported
        LIMIT 100
    `, [status]);

    const reviews = rows.map((r) => ({
        ...r,
        author: r.author ?? "[deleted user]",
        report_count: Number(r.report_count)
    }));

    res.json(await withGameCards(reviews));
}));


// PATCH /api/moderation/reviews/:reviewId  { action }
//   hide     -> review hidden,  its open reports resolved
//   remove   -> review removed, its open reports resolved
//   dismiss  -> review stays,   its open reports dismissed
//   restore  -> a hidden review becomes visible again
// The review row is locked first, so two moderators acting at the same
// time are applied one after the other rather than overwriting each other.
const ACTIONS = {
    hide:    { reviewStatus: "hidden",  flagStatus: "resolved" },
    remove:  { reviewStatus: "removed", flagStatus: "resolved" },
    dismiss: { reviewStatus: null,      flagStatus: "dismissed" },
    restore: { reviewStatus: "active",  flagStatus: null }
};

router.patch("/reviews/:reviewId", handle(async (req, res) => {
    const reviewId = parseId(req.params.reviewId, "review id");
    const action = ACTIONS[req.body?.action];
    if (!action) throw new HttpError(400, `action must be one of: ${Object.keys(ACTIONS).join(", ")}`);

    const result = await inTransaction(mysql, async (conn) => {
        const [[review]] = await conn.query(
            "SELECT status FROM review WHERE review_id = ? FOR UPDATE", [reviewId]
        );
        if (!review) throw new HttpError(404, "Review not found");

        let flagsUpdated = 0;

        if (action.reviewStatus) {
            await conn.query("UPDATE review SET status = ? WHERE review_id = ?", [action.reviewStatus, reviewId]);
        }

        if (action.flagStatus) {
            // resolved_at is set together with the status, as chk_flag_resolution requires
            const [updated] = await conn.query(`
                UPDATE flag_report
                SET status = ?, moderator_id = ?, resolved_at = CURRENT_TIMESTAMP
                WHERE review_id = ? AND status = 'open'
            `, [action.flagStatus, req.userId, reviewId]);
            flagsUpdated = updated.affectedRows;
        }

        return { previousStatus: review.status, newStatus: action.reviewStatus ?? review.status, flagsUpdated };
    });

    res.json(result);
}));


module.exports = router;
