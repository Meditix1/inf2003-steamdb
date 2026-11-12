// =========================================================
// /api/quiz — recommendation quiz
//   questions, answers and genre preferences: MySQL
//   recommended games: MongoDB, scored by those preferences
// =========================================================

const express = require("express");
const mysql = require("../db/mysql");
const { getMongoDB } = require("../db/mongodb");
const { sessionUserId, requireLogin } = require("../middleware/auth");
const { handle, HttpError, inTransaction } = require("../lib/http");

const router = express.Router();


// GET /api/quiz — questions with their options (and my previous answers, if any)
router.get("/", handle(async (req, res) => {
    const [rows] = await mysql.query(`
        SELECT q.question_id, q.prompt, o.option_id, o.label
        FROM quiz_question q JOIN quiz_option o ON o.question_id = q.question_id
        ORDER BY q.display_order, q.question_id, o.option_id`);

    const questions = [];
    for (const r of rows) {
        let q = questions[questions.length - 1];
        if (!q || q.question_id !== r.question_id) {
            q = { question_id: r.question_id, prompt: r.prompt, options: [] };
            questions.push(q);
        }
        q.options.push({ option_id: r.option_id, label: r.label });
    }

    const userId = sessionUserId(req);
    let answers = {};
    if (userId) {
        const [a] = await mysql.query("SELECT question_id, option_id FROM quiz_response WHERE user_id = ?", [userId]);
        answers = Object.fromEntries(a.map((x) => [x.question_id, x.option_id]));
    }
    res.json({ questions, answers });
}));


// POST /api/quiz/answers  { answers: { "<question_id>": <option_id>, ... } }
// One transaction: save the answers, then rebuild the user's genre preferences
// from them with INSERT ... SELECT ... GROUP BY. The composite foreign key
// (question_id, option_id) -> quiz_option rejects an option from another question.
router.post("/answers", requireLogin, handle(async (req, res) => {
    const given = req.body?.answers;
    if (!given || typeof given !== "object") throw new HttpError(400, "answers must be an object");

    const [questions] = await mysql.query("SELECT question_id FROM quiz_question");
    const rows = questions.map(({ question_id }) => {
        const optionId = Number(given[question_id]);
        if (!Number.isInteger(optionId) || optionId <= 0) throw new HttpError(400, "Answer every question");
        return [req.userId, question_id, optionId];
    });

    try {
        await inTransaction(mysql, async (conn) => {
            await conn.query(`
                INSERT INTO quiz_response (user_id, question_id, option_id) VALUES ?
                ON DUPLICATE KEY UPDATE option_id = VALUES(option_id), submitted_at = CURRENT_TIMESTAMP`, [rows]);
            await conn.query("DELETE FROM user_genre_preference WHERE user_id = ?", [req.userId]);
            await conn.query(`
                INSERT INTO user_genre_preference (user_id, genre_name, score)
                SELECT r.user_id, o.genre_name, COUNT(*)
                FROM quiz_response r
                JOIN quiz_option o ON o.question_id = r.question_id AND o.option_id = r.option_id
                WHERE r.user_id = ? AND o.genre_name IS NOT NULL
                GROUP BY r.user_id, o.genre_name`, [req.userId]);
        });
    } catch (err) {
        if (err.code === "ER_NO_REFERENCED_ROW_2" || err.code === "ER_NO_REFERENCED_ROW") {
            throw new HttpError(400, "One of the answers doesn't belong to its question");
        }
        throw err;
    }
    res.json({ saved: true });
}));


// GET /api/quiz/results — my genre preferences and recommended games.
// Each game scores the sum of my weights for the genres it has; ties go to the
// better reviewed game. Games I own are left out. Needs the cleaned games data.
router.get("/results", requireLogin, handle(async (req, res) => {
    const [prefs] = await mysql.query(
        "SELECT genre_name, score FROM user_genre_preference WHERE user_id = ? ORDER BY score DESC, genre_name", [req.userId]);
    if (!prefs.length) return res.json({ preferences: [], games: [] });

    const [owned] = await mysql.query("SELECT game_id FROM library WHERE user_id = ?", [req.userId]);
    const ownedIds = owned.map((o) => String(o.game_id));
    const genres = prefs.map((p) => p.genre_name);

    const games = await getMongoDB().collection("games").aggregate([
        { $match: {
            genres: { $in: genres },
            _id: { $nin: ownedIds },
            positive: { $gte: 200 }          // enough reviews for the score to mean something
        } },
        { $addFields: { match_score: { $add: prefs.map((p) => ({ $cond: [{ $in: [p.genre_name, "$genres"] }, p.score, 0] })) } } },
        { $sort: { match_score: -1, wilson_score: -1, _id: 1 } },
        { $limit: 24 },
        { $project: { name: 1, header_image: 1, price: 1, genres: 1, wilson_score: 1, match_score: 1 } }
    ]).toArray();

    const total = prefs.reduce((n, p) => n + p.score, 0);
    res.json({
        preferences: prefs.map((p) => ({ genre: p.genre_name, score: p.score, share: Math.round((100 * p.score) / total) })),
        games: games.map((g) => ({
            app_id: Number(g._id), name: g.name, header_image: g.header_image, price: g.price,
            genres: g.genres, match_score: g.match_score, rating_pct: Math.round((g.wilson_score || 0) * 100)
        }))
    });
}));


module.exports = router;
