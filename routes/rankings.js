// =========================================================
// /api/rankings — leaderboards
//   catalogue rankings (per genre, per year): MongoDB window function $setWindowFields
//   community rankings (owned, wishlisted, rated, reviewers): MySQL CTE + RANK()/DENSE_RANK()
// Results are cached for 10 minutes; the catalogue doesn't change.
// =========================================================

const express = require("express");
const mysql = require("../db/mysql");
const { getMongoDB } = require("../db/mongodb");
const { handle } = require("../lib/http");
const { getGameCards } = require("../lib/catalogue");

const router = express.Router();
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map();

async function cached(key, fn) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const value = await fn();
    cache.set(key, { at: Date.now(), value });
    return value;
}

const games = () => getMongoDB().collection("games");
const pct = (w) => Math.round((w || 0) * 100);


// GET /api/rankings/genres — top 5 games in every genre
// $rank inside $setWindowFields, partitioned by genre: MongoDB's equivalent of
// RANK() OVER (PARTITION BY genre ORDER BY wilson_score DESC)
router.get("/genres", handle(async (req, res) => {
    res.json(await cached("genres", async () => {
        const rows = await games().aggregate([
            { $match: { positive: { $gte: 500 } } },        // enough reviews to rank fairly
            { $project: { name: 1, header_image: 1, wilson_score: 1, positive: 1, negative: 1, genres: 1 } },
            { $unwind: "$genres" },
            { $setWindowFields: {
                partitionBy: "$genres",
                sortBy: { wilson_score: -1 },
                output: { rank: { $rank: {} }, genre_size: { $count: {} } }
            } },
            { $match: { rank: { $lte: 5 }, genre_size: { $gte: 5 } } },
            { $sort: { genres: 1, rank: 1, _id: 1 } }
        ]).toArray();

        const byGenre = new Map();
        for (const r of rows) {
            if (!byGenre.has(r.genres)) byGenre.set(r.genres, { genre: r.genres, games: [] });
            if (byGenre.get(r.genres).games.length >= 10) continue;   // ties share a rank; cap the list
            byGenre.get(r.genres).games.push({ rank: r.rank, app_id: Number(r._id), name: r.name,
                header_image: r.header_image, rating_pct: pct(r.wilson_score), reviews: r.positive + r.negative });
        }
        return [...byGenre.values()];
    }));
}));


// GET /api/rankings/years — top 3 games of every release year
router.get("/years", handle(async (req, res) => {
    res.json(await cached("years", async () => {
        const rows = await games().aggregate([
            { $match: { release_date: { $ne: null }, positive: { $gte: 200 } } },
            { $project: { name: 1, header_image: 1, wilson_score: 1, positive: 1, negative: 1, year: { $year: "$release_date" } } },
            { $setWindowFields: {
                partitionBy: "$year",
                sortBy: { wilson_score: -1 },
                output: { rank: { $rank: {} } }
            } },
            { $match: { rank: { $lte: 3 } } },
            { $sort: { year: -1, rank: 1, _id: 1 } }
        ]).toArray();

        const byYear = new Map();
        for (const r of rows) {
            if (!byYear.has(r.year)) byYear.set(r.year, { year: r.year, games: [] });
            if (byYear.get(r.year).games.length >= 10) continue;
            byYear.get(r.year).games.push({ rank: r.rank, app_id: Number(r._id), name: r.name,
                header_image: r.header_image, rating_pct: pct(r.wilson_score), reviews: r.positive + r.negative });
        }
        return [...byYear.values()];
    }));
}));


// GET /api/rankings/community — what this site's users own, want and rate
router.get("/community", handle(async (req, res) => {
    res.json(await cached("community", async () => {
        // Most owned: CTE of counts, then RANK() (ties share a rank, the next rank skips)
        const [owned] = await mysql.query(`
            WITH owners AS (
                SELECT game_id, COUNT(*) AS owners FROM library GROUP BY game_id
            ), players AS (
                SELECT COUNT(DISTINCT user_id) AS n FROM library
            )
            SELECT o.game_id, o.owners,
                   ROUND(100 * o.owners / p.n, 1) AS pct_of_players,
                   RANK() OVER (ORDER BY o.owners DESC) AS rnk
            FROM owners o CROSS JOIN players p
            ORDER BY rnk, o.game_id LIMIT 10`);

        const [wished] = await mysql.query(`
            SELECT game_id, COUNT(*) AS wishers,
                   RANK() OVER (ORDER BY COUNT(*) DESC) AS rnk
            FROM wishlist GROUP BY game_id
            ORDER BY rnk, game_id LIMIT 10`);

        // Best rated by our users: from the review-stats view, DENSE_RANK (no gaps)
        const [rated] = await mysql.query(`
            SELECT game_id, review_count, avg_rating, pct_positive,
                   DENSE_RANK() OVER (ORDER BY avg_rating DESC) AS rnk
            FROM v_game_review_stats
            WHERE review_count >= 3
            ORDER BY rnk, review_count DESC, game_id LIMIT 10`);

        const [reviewers] = await mysql.query(`
            SELECT username, reviews_written, helpful_received,
                   DENSE_RANK() OVER (ORDER BY helpful_received DESC) AS rnk
            FROM v_user_activity
            WHERE reviews_written > 0
            ORDER BY rnk, reviews_written DESC, username LIMIT 10`);

        // Titles and images for all listed games in one MongoDB query
        const cards = await getGameCards([...owned, ...wished, ...rated].map((r) => r.game_id));
        const withGame = (rows) => rows.map((r) => ({ ...r, rank: Number(r.rnk), rnk: undefined,
            name: cards.get(r.game_id)?.name ?? `Game ${r.game_id}`, header_image: cards.get(r.game_id)?.header_image ?? null }));

        return {
            most_owned: withGame(owned),
            most_wishlisted: withGame(wished),
            best_rated: withGame(rated).map((r) => ({ ...r, avg_rating: Number(r.avg_rating), pct_positive: Number(r.pct_positive) })),
            top_reviewers: reviewers.map((r) => ({ rank: Number(r.rnk), username: r.username,
                reviews_written: Number(r.reviews_written), helpful_received: Number(r.helpful_received) }))
        };
    }));
}));


module.exports = router;
