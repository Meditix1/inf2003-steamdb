// =========================================================
// BENCHMARK ONLY: the games query exactly as routes/games.js ran it on
// 4 Nov 2026, before the MongoDB clean-up (P1 "before").
// Generated mechanically from that file, so the query logic is identical.
// The live site no longer uses this.
// =========================================================

function parseIntInRange(value, min, max) {
    if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
    const n = Number(value);
    return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}

function parseNameList(value) {
    // Repeated query parameters also support names containing commas.
    const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
    return [...new Set(values.map(queryText).filter(Boolean))].slice(0, 10);
}

function queryText(value) {
    return typeof value === "string" ? value.trim() : "";
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const PLATFORM_FIELDS = new Map([
    ["windows", "windows"], ["mac", "mac"], ["linux", "linux"]
]);
const SORTS = new Map([
    ["name", { name: 1, _appId: 1 }],
    ["rating", { _rating: -1, _appId: 1 }],
    ["popular", { peak_ccu: -1, _appId: 1 }],
    ["newest", { _releaseDate: -1, _appId: 1 }],
    ["price_asc", { price: 1, name: 1, _appId: 1 }]
]);

// Source dates are strings such as "Jul 29, 2016". Parse before sorting or
// filtering; string order would incorrectly sort alphabetically by month.
// BSON dates and ISO strings also work. Invalid/missing dates become null.
const RELEASE_DATE = {
    $cond: [
        { $eq: [{ $type: "$release_date" }, "date"] },
        "$release_date",
        { $dateFromString: {
            dateString: "$release_date", onError: null, onNull: null
        } }
    ]
};

const TAG_NAMES = {
    // $ifNull alone does not handle the dataset's tags: [] values.
    // Only evaluate $objectToArray when tags is actually a document.
    $cond: [
        { $eq: [{ $type: "$tags" }, "object"] },
        { $map: {
            input: { $objectToArray: "$tags" },
            as: "tag",
            in: "$$tag.k"
        } },
        []
    ]
};

// Wilson score lower bound (95%), equivalent to the previous SQL expression.
const WILSON = {
    $let: {
        vars: {
            p: { $ifNull: ["$positive", 0] },
            n: { $ifNull: ["$negative", 0] }
        },
        in: { $let: {
            vars: { total: { $add: ["$$p", "$$n"] } },
            in: { $cond: [
                { $eq: ["$$total", 0] },
                0,
                { $divide: [
                    { $subtract: [
                        { $divide: [{ $add: ["$$p", 1.9208] }, "$$total"] },
                        { $divide: [
                            { $multiply: [1.96, { $sqrt: { $add: [
                                { $divide: [{ $multiply: ["$$p", "$$n"] }, "$$total"] },
                                0.9604
                            ] } }] },
                            "$$total"
                        ] }
                    ] },
                    { $add: [1, { $divide: [3.8416, "$$total"] }] }
                ] }
            ] }
        } }
    }
};

// Build filter options entirely from MongoDB; no SQL catalogue tables needed.
const FILTER_CACHE_MS = 10 * 60 * 1000;
let filterCache = null;
let filterCacheTime = 0;

function nameOptions(field) {
    return [
        { $unwind: `$${field}` },
        { $match: { [field]: { $type: "string", $ne: "" } } },
        { $group: { _id: `$${field}` } },
        { $sort: { _id: 1 } },
        { $project: { _id: 0, id: "$_id", name: "$_id" } }
    ];
}


function filtersPipeline() {
    return [
                { $project: {
                    tags: TAG_NAMES,
                    genres: 1,
                    categories: 1,
                    supported_languages: 1,
                    _releaseDate: RELEASE_DATE
                } },
                { $facet: {
                    genres: nameOptions("genres"),
                    categories: nameOptions("categories"),
                    tags: [
                        { $unwind: "$tags" },
                        { $match: { tags: { $ne: "" } } },
                        { $group: { _id: "$tags", games: { $sum: 1 } } },
                        { $sort: { games: -1, _id: 1 } },
                        { $project: { _id: 0, id: "$_id", name: "$_id", games: 1 } }
                    ],
                    languages: [
                        { $unwind: "$supported_languages" },
                        { $match: { supported_languages: { $type: "string", $ne: "" } } },
                        { $group: { _id: "$supported_languages", games: { $sum: 1 } } },
                        { $sort: { games: -1, _id: 1 } }
                    ],
                    years: [
                        { $match: { _releaseDate: { $ne: null } } },
                        { $group: {
                            _id: null,
                            min: { $min: { $year: "$_releaseDate" } },
                            max: { $max: { $year: "$_releaseDate" } }
                        } },
                        { $project: { _id: 0, min: 1, max: 1 } }
                    ]
                } }
            ];
}

// Same pipeline and options the old GET /api/games built for query string q
function buildGamesPipeline(q) {

        const match = {};
        const expressions = [];

        const search = queryText(q.search);
        if (search) match.name = { $regex: escapeRegex(search), $options: "i" };

        const genre = queryText(q.genre);
        const tags = parseNameList(q.tags);
        const categories = parseNameList(q.categories);
        if (genre) match.genres = { $all: [genre] };
        if (categories.length) match.categories = { $all: categories };
        if (tags.length) {
            // Compare object keys as values; tag names may contain dots/$.
            expressions.push({ $setIsSubset: [{ $literal: tags }, TAG_NAMES] });
        }

        const platforms = queryText(q.platforms).split(",")
            .map((p) => PLATFORM_FIELDS.get(p.trim().toLowerCase())).filter(Boolean);
        for (const field of new Set(platforms)) match[field] = true;

        const language = queryText(q.language);
        if (language) {
            match.supported_languages = language;
            if (q.fullAudio === "1") match.full_audio_languages = language;
        }

        const maxAge = parseIntInRange(q.maxAge, 0, 21);
        if (maxAge !== null) {
            expressions.push({ $lte: [{ $ifNull: ["$required_age", 0] }, maxAge] });
        }
        if (q.free === "1") {
            expressions.push({ $eq: [{ $ifNull: ["$price", 0] }, 0] });
        }
        if (expressions.length) match.$expr = { $and: expressions };

        const year = parseIntInRange(q.year, 1970, 2100);
        const decade = parseIntInRange(q.decade, 1970, 2100);
        const startYear = year || (decade && decade % 10 === 0 ? decade : null);
        const sort = SORTS.get(q.sort) || SORTS.get("name");
        const limit = parseIntInRange(q.limit, 1, 60) || 24;
        const page = parseIntInRange(q.page, 1, 100000) || 1;

        const pipeline = [
            { $match: match },
            // Leave descriptions, screenshots and other large fields out of sorting.
            { $project: {
                name: 1, price: 1, header_image: 1, required_age: 1,
                positive: 1, negative: 1, peak_ccu: 1,
                windows: 1, mac: 1, linux: 1,
                _releaseDate: RELEASE_DATE
            } }
        ];
        if (startYear) {
            pipeline.push({ $match: { _releaseDate: {
                $gte: new Date(Date.UTC(startYear, 0, 1)),
                $lt: new Date(Date.UTC(startYear + (year ? 1 : 10), 0, 1))
            } } });
        }

        const sortFields = {
            _appId: { $convert: { input: "$_id", to: "int", onError: null, onNull: null } }
        };
        if (q.sort === "rating") sortFields._rating = WILSON;

        // Count and page use the same filters. Only the page branch calculates
        // scores; games are projected to the field names the frontend expects.
        pipeline.push({ $facet: {
            metadata: [{ $count: "total" }],
            games: [
                { $addFields: sortFields },
                { $sort: sort },
                { $skip: (page - 1) * limit },
                { $limit: limit },
                { $project: {
                    _id: 0,
                    app_id: "$_appId",
                    name: 1,
                    price: { $ifNull: ["$price", 0] },
                    is_free: { $cond: [{ $eq: [{ $ifNull: ["$price", 0] }, 0] }, 1, 0] },
                    header_image: 1,
                    release_date: { $dateToString: {
                        date: "$_releaseDate", format: "%Y-%m-%d", onNull: null
                    } },
                    required_age: { $ifNull: ["$required_age", 0] },
                    positive: { $ifNull: ["$positive", 0] },
                    negative: { $ifNull: ["$negative", 0] },
                    peak_ccu: { $ifNull: ["$peak_ccu", 0] },
                    supports_windows: { $cond: ["$windows", 1, 0] },
                    supports_mac: { $cond: ["$mac", 1, 0] },
                    supports_linux: { $cond: ["$linux", 1, 0] }
                } }
            ]
        } });

        return { pipeline, options: { collation: { locale: "en", strength: 2 } } };
}

async function queryGames(collection, q) {
    const { pipeline, options } = buildGamesPipeline(q);
    const [result] = await collection.aggregate(pipeline, options).toArray();
    return { total: result.metadata[0]?.total || 0, games: result.games };
}

function explainGames(collection, q) {
    const { pipeline, options } = buildGamesPipeline(q);
    return collection.aggregate(pipeline, options).explain("executionStats");
}

async function queryFilters(collection) {
    const [options] = await collection.aggregate(filtersPipeline()).toArray();
    return options;
}

function explainFilters(collection) {
    return collection.aggregate(filtersPipeline()).explain("executionStats");
}

module.exports = { queryGames, explainGames, queryFilters, explainFilters };
