const express = require("express");
const { getMongoDB } = require("../db/mongodb");

const router = express.Router();

// Uses the fields stored by scripts/setup/clean_games.js:
//   release_date (Date), tag_names (array), wilson_score, name_lower
// Every filter is a plain field condition, so MongoDB can answer it from an
// index instead of reading all 50,000 documents. The previous version computed
// these values inside every query; it is kept in scripts/bench/games_before.js
// for the before/after comparison.

function gamesCollection() {
    const db = getMongoDB();
    if (!db) throw new Error("MongoDB is not connected; await connectMongo() before listening");
    return db.collection("games");
}

function parseIntInRange(value, min, max) {
    if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
    const n = Number(value);
    return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}

function queryText(value) {
    return typeof value === "string" ? value.trim() : "";
}

function parseNameList(value) {
    // Repeated query parameters also support names containing commas.
    const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
    return [...new Set(values.map(queryText).filter(Boolean))].slice(0, 10);
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const PLATFORM_FIELDS = new Map([["windows", "windows"], ["mac", "mac"], ["linux", "linux"]]);

// Every sort ends with _id so pages are stable
const SORTS = new Map([
    ["name", { name_lower: 1, _id: 1 }],
    ["rating", { wilson_score: -1, _id: 1 }],
    ["popular", { peak_ccu: -1, _id: 1 }],
    ["newest", { release_date: -1, _id: 1 }],
    ["price_asc", { price: 1, name_lower: 1, _id: 1 }]
]);

const CARD_PROJECTION = {
    name: 1, price: 1, header_image: 1, release_date: 1, required_age: 1,
    positive: 1, negative: 1, peak_ccu: 1, windows: 1, mac: 1, linux: 1
};

// Query string -> MongoDB filter, sort and page
function buildGamesQuery(q) {
    const filter = {};

    const search = queryText(q.search);
    if (search) filter.name_lower = { $regex: escapeRegex(search.toLowerCase()) };

    const genre = queryText(q.genre);
    if (genre) filter.genres = genre;

    const categories = parseNameList(q.categories);
    if (categories.length) filter.categories = { $all: categories };

    const tags = parseNameList(q.tags);
    if (tags.length) filter.tag_names = { $all: tags };

    const platforms = queryText(q.platforms).split(",")
        .map((p) => PLATFORM_FIELDS.get(p.trim().toLowerCase())).filter(Boolean);
    for (const field of new Set(platforms)) filter[field] = true;

    const language = queryText(q.language);
    if (language) {
        filter.supported_languages = language;
        if (q.fullAudio === "1") filter.full_audio_languages = language;
    }

    const maxAge = parseIntInRange(q.maxAge, 0, 21);
    if (maxAge !== null) filter.required_age = { $lte: maxAge };

    if (q.free === "1") filter.price = 0;

    const year = parseIntInRange(q.year, 1970, 2100);
    const decade = parseIntInRange(q.decade, 1970, 2100);
    const startYear = year || (decade && decade % 10 === 0 ? decade : null);
    if (startYear) {
        filter.release_date = {
            $gte: new Date(Date.UTC(startYear, 0, 1)),
            $lt: new Date(Date.UTC(startYear + (year ? 1 : 10), 0, 1))
        };
    }

    const limit = parseIntInRange(q.limit, 1, 60) || 24;
    const page = parseIntInRange(q.page, 1, 100000) || 1;
    return { filter, sort: SORTS.get(q.sort) || SORTS.get("name"), limit, page, skip: (page - 1) * limit };
}

function toCard(d) {
    const price = d.price ?? 0;
    return {
        app_id: Number(d._id),
        name: d.name,
        price,
        is_free: price === 0 ? 1 : 0,
        header_image: d.header_image,
        release_date: d.release_date instanceof Date ? d.release_date.toISOString().slice(0, 10) : null,
        required_age: d.required_age ?? 0,
        positive: d.positive ?? 0,
        negative: d.negative ?? 0,
        peak_ccu: d.peak_ccu ?? 0,
        supports_windows: d.windows ? 1 : 0,
        supports_mac: d.mac ? 1 : 0,
        supports_linux: d.linux ? 1 : 0
    };
}

// Count and page run as two indexed queries in parallel. (The old version used
// $facet, but a sort inside $facet can't use an index, so it sorted in memory.)
async function queryGames(collection, q) {
    const { filter, sort, skip, limit } = buildGamesQuery(q);
    const hasFilter = Object.keys(filter).length > 0;
    const [total, docs] = await Promise.all([
        hasFilter ? collection.countDocuments(filter) : collection.estimatedDocumentCount(),
        collection.find(filter, { projection: CARD_PROJECTION }).sort(sort).skip(skip).limit(limit).toArray()
    ]);
    return { total, games: docs.map(toCard) };
}

function explainGames(collection, q) {
    const { filter, sort, skip, limit } = buildGamesQuery(q);
    return collection.find(filter, { projection: CARD_PROJECTION }).sort(sort).skip(skip).limit(limit).explain("executionStats");
}

// Filter options: genres and categories from their indexes (distinct),
// tag and language counts by aggregation, year range from the date index
function countPipeline(field) {
    return [
        { $unwind: `$${field}` },
        { $match: { [field]: { $type: "string", $ne: "" } } },
        { $group: { _id: `$${field}`, games: { $sum: 1 } } },
        { $sort: { games: -1, _id: 1 } }
    ];
}

async function queryFilters(collection) {
    const names = (list) => list.filter((v) => typeof v === "string" && v).sort((a, b) => a.localeCompare(b))
        .map((v) => ({ id: v, name: v }));

    const [genres, categories, tags, languages, first, last] = await Promise.all([
        collection.distinct("genres"),
        collection.distinct("categories"),
        collection.aggregate(countPipeline("tag_names")).toArray(),
        collection.aggregate(countPipeline("supported_languages")).toArray(),
        collection.find({ release_date: { $ne: null } }, { projection: { release_date: 1 } }).sort({ release_date: 1 }).limit(1).next(),
        collection.find({ release_date: { $ne: null } }, { projection: { release_date: 1 } }).sort({ release_date: -1 }).limit(1).next()
    ]);

    return {
        genres: names(genres),
        categories: names(categories),
        tags: tags.map((t) => ({ id: t._id, name: t._id, games: t.games })),
        languages: languages.map((l) => l._id),
        years: {
            min: first ? first.release_date.getUTCFullYear() : null,
            max: last ? last.release_date.getUTCFullYear() : null
        }
    };
}

function explainFilters(collection) {
    return collection.aggregate(countPipeline("tag_names")).explain("executionStats");
}


const FILTER_CACHE_MS = 10 * 60 * 1000;
let filterCache = null;
let filterCacheTime = 0;

// GET /api/games/filters
router.get("/filters", async (req, res) => {
    try {
        if (filterCache && Date.now() - filterCacheTime < FILTER_CACHE_MS) return res.json(filterCache);
        filterCache = await queryFilters(gamesCollection());
        filterCacheTime = Date.now();
        res.json(filterCache);
    } catch (error) {
        console.error("Filters query error:", error);
        res.status(500).json({ message: "Unable to retrieve filter options" });
    }
});

// GET /api/games — search, genre, tags, categories, platforms, language,
// fullAudio, maxAge, free, year, decade, sort, page, limit
router.get("/", async (req, res) => {
    try {
        const { page, limit } = buildGamesQuery(req.query);
        const result = await queryGames(gamesCollection(), req.query);
        res.json({ total: result.total, page, limit, games: result.games });
    } catch (error) {
        console.error("Games query error:", error);
        res.status(500).json({ message: "Unable to retrieve games" });
    }
});

// GET /api/games/:id — everything the game page shows, from ONE document
// (the relational copy needs a 7-table join for the same page; see benchmark P3 Q6)
router.get("/:id", async (req, res) => {
    try {
        if (!/^\d{1,10}$/.test(req.params.id)) return res.status(404).json({ message: "Game not found" });
        const d = await gamesCollection().findOne({ _id: req.params.id }, {
            projection: { about_the_game: 0, packages: 0, name_lower: 0, tag_names: 0, notes: 0, reviews: 0 }
        });
        if (!d) return res.status(404).json({ message: "Game not found" });

        // Tags sorted by how many players applied them
        const tags = Object.entries(d.tags || {}).sort((a, b) => b[1] - a[1]).map(([name, votes]) => ({ name, votes }));

        res.json({
            ...toCard(d),
            short_description: d.short_description || null,
            detailed_description: d.detailed_description || null,
            discount: d.discount ?? 0,
            dlc_count: d.dlc_count ?? 0,
            metacritic_score: d.metacritic_score || null,
            recommendations: d.recommendations ?? 0,
            estimated_owners: d.estimated_owners || null,
            achievements: d.achievements ?? 0,
            avg_playtime_hours: Math.round((d.average_playtime_forever || 0) / 60),
            rating_pct: Math.round((d.wilson_score || 0) * 100),
            genres: d.genres || [],
            categories: d.categories || [],
            tags,
            developers: d.developers || [],
            publishers: d.publishers || [],
            supported_languages: d.supported_languages || [],
            full_audio_languages: d.full_audio_languages || [],
            screenshots: (d.screenshots || []).slice(0, 12),
            movies: (d.movies || []).slice(0, 3),
            website: d.website || null
        });
    } catch (error) {
        console.error("Game detail error:", error);
        res.status(500).json({ message: "Unable to retrieve game" });
    }
});


// GET /api/games/:id/similar — games sharing the most of this game's top tags.
// $setIntersection counts shared tags per candidate; the multikey index on
// tag_names narrows candidates to games with at least one of them.
router.get("/:id/similar", async (req, res) => {
    try {
        if (!/^\d{1,10}$/.test(req.params.id)) return res.status(404).json({ message: "Game not found" });
        const col = gamesCollection();
        const game = await col.findOne({ _id: req.params.id }, { projection: { tags: 1 } });
        if (!game) return res.status(404).json({ message: "Game not found" });

        const top = Object.entries(game.tags || {}).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([t]) => t);
        if (!top.length) return res.json({ tags: [], games: [] });

        const docs = await col.aggregate([
            { $match: { _id: { $ne: req.params.id }, tag_names: { $in: top }, positive: { $gte: 50 } } },
            { $addFields: { shared: { $size: { $setIntersection: ["$tag_names", top] } } } },
            { $match: { shared: { $gte: Math.min(3, top.length) } } },
            { $sort: { shared: -1, wilson_score: -1, _id: 1 } },
            { $limit: 8 },
            { $project: { ...CARD_PROJECTION, shared: 1, tag_names: 1 } }
        ]).toArray();

        res.json({
            tags: top,
            games: docs.map((d) => ({ ...toCard(d), shared: d.shared,
                shared_tags: d.tag_names.filter((t) => top.includes(t)) }))
        });
    } catch (error) {
        console.error("Similar games error:", error);
        res.status(500).json({ message: "Unable to retrieve similar games" });
    }
});

module.exports = router;
module.exports.queryGames = queryGames;
module.exports.explainGames = explainGames;
module.exports.queryFilters = queryFilters;
module.exports.explainFilters = explainFilters;
