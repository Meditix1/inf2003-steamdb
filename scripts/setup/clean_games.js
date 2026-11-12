// =========================================================
// MongoDB `games` clean-up (P1 "after"). Run ONLY after the "before"
// benchmark is saved. Safe to re-run.
//
//   1. Fix types in place (one server-side pipeline update, no data leaves MongoDB):
//        release_date  "Jul 29, 2016" -> Date (null if unparseable, e.g. "Coming soon")
//        discount      "65" -> 65 (int, clamped 0-100)
//        tags          [] for untagged games -> {} (always an object of name -> votes)
//      and store values the old queries computed every time:
//        tag_names     ["Adventure", ...]   (indexable array of the tag keys)
//        wilson_score  Wilson lower bound of positive/negative reviews
//        name_lower    lower-case name, for case-insensitive sort and search with an index
//      and drop about_the_game where it's an exact copy of detailed_description.
//   2. $jsonSchema validator.
//   3. Indexes for every homepage filter and sort.
//
// Needs at least 500 MB free disk (MongoDB refuses to build indexes otherwise).
// Run on the VM, from ~/steamdb-web:
//   docker cp scripts/setup/clean_games.js steamdb-mongodb:/tmp/clean.js
//   docker exec -it steamdb-mongodb mongosh -u admin -p --authenticationDatabase admin steamdb --file /tmp/clean.js
// =========================================================

const WILSON = {
    $let: {
        vars: { p: { $ifNull: ["$positive", 0] }, n: { $ifNull: ["$negative", 0] } },
        in: { $let: {
            vars: { t: { $add: ["$$p", "$$n"] } },
            in: { $cond: [{ $eq: ["$$t", 0] }, 0, { $divide: [
                { $subtract: [{ $divide: [{ $add: ["$$p", 1.9208] }, "$$t"] },
                    { $divide: [{ $multiply: [1.96, { $sqrt: { $add: [{ $divide: [{ $multiply: ["$$p", "$$n"] }, "$$t"] }, 0.9604] } }] }, "$$t"] }] },
                { $add: [1, { $divide: [3.8416, "$$t"] }] }] }] }
        } }
    }
};

print("1. Cleaning documents...");
const t0 = Date.now();
const res = db.games.updateMany({}, [
    { $set: {
        release_date: { $cond: [{ $eq: [{ $type: "$release_date" }, "date"] }, "$release_date",
            { $dateFromString: { dateString: "$release_date", onError: null, onNull: null } }] },
        discount: { $min: [100, { $max: [0, { $convert: {
            input: { $convert: { input: "$discount", to: "double", onError: 0, onNull: 0 } }, to: "int", onError: 0 } }] }] },
        tags: { $cond: [{ $eq: [{ $type: "$tags" }, "object"] }, "$tags", {}] }
    } },
    { $set: {
        tag_names: { $map: { input: { $objectToArray: "$tags" }, as: "t", in: "$$t.k" } },
        wilson_score: { $toDouble: WILSON },
        name_lower: { $toLower: { $ifNull: ["$name", ""] } },
        about_the_game: { $cond: [{ $eq: ["$about_the_game", "$detailed_description"] }, "$$REMOVE", "$about_the_game"] }
    } }
]);
print(`   ${res.matchedCount} matched, ${res.modifiedCount} modified in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
print(`   unparseable release dates (now null): ${db.games.countDocuments({ release_date: null })}`);
print(`   games with no tags: ${db.games.countDocuments({ tag_names: { $size: 0 } })}`);
print(`   about_the_game kept (differs from detailed_description): ${db.games.countDocuments({ about_the_game: { $exists: true } })}`);

print("2. Validator...");
const schema = {
    bsonType: "object",
    required: ["_id", "name", "name_lower", "price", "discount", "windows", "mac", "linux",
               "genres", "categories", "tags", "tag_names", "positive", "negative", "wilson_score"],
    properties: {
        _id: { bsonType: "string", pattern: "^[0-9]+$", description: "Steam app id" },
        name: { bsonType: "string" },
        name_lower: { bsonType: "string" },
        price: { bsonType: ["double", "int", "long", "decimal"], minimum: 0 },
        discount: { bsonType: "int", minimum: 0, maximum: 100 },
        release_date: { bsonType: ["date", "null"] },
        required_age: { bsonType: ["int", "long"], minimum: 0 },
        windows: { bsonType: "bool" }, mac: { bsonType: "bool" }, linux: { bsonType: "bool" },
        genres: { bsonType: "array", items: { bsonType: "string" } },
        categories: { bsonType: "array", items: { bsonType: "string" } },
        tags: { bsonType: "object", description: "tag name -> votes" },
        tag_names: { bsonType: "array", items: { bsonType: "string" } },
        supported_languages: { bsonType: "array", items: { bsonType: "string" } },
        full_audio_languages: { bsonType: "array", items: { bsonType: "string" } },
        positive: { bsonType: ["int", "long"], minimum: 0 },
        negative: { bsonType: ["int", "long"], minimum: 0 },
        peak_ccu: { bsonType: ["int", "long"], minimum: 0 },
        wilson_score: { bsonType: "double", minimum: 0, maximum: 1 }
    }
};
const failing = db.games.countDocuments({ $nor: [{ $jsonSchema: schema }] });
// "moderate" still checks every insert, and updates to valid documents,
// but doesn't block edits to a few odd legacy documents
const level = failing === 0 ? "strict" : "moderate";
db.runCommand({ collMod: "games", validator: { $jsonSchema: schema }, validationLevel: level, validationAction: "error" });
print(`   ${failing} existing documents fail the schema -> validationLevel "${level}"`);
if (failing) db.games.find({ $nor: [{ $jsonSchema: schema }] }, { _id: 1, name: 1 }).limit(5).forEach((d) => print(`     e.g. ${d._id} ${d.name}`));

print("3. Indexes...");
// Sort indexes end with _id because every sort in games.js ends with _id
// (stable pages). An index can only provide a sort if it holds the whole sort.
const indexes = [
    [{ name_lower: 1, _id: 1 }, "idx_name"],                           // default sort, name search
    [{ wilson_score: -1, _id: 1 }, "idx_rating"],                      // rating sort ("best of year" scans this in order)
    [{ genres: 1, wilson_score: -1, _id: 1 }, "idx_genre_rating"],     // genre page by rating
    [{ peak_ccu: -1, _id: 1 }, "idx_popular"],
    [{ release_date: -1, _id: 1 }, "idx_newest"],                      // newest sort, year/decade range
    [{ price: 1, name_lower: 1, _id: 1 }, "idx_price"],
    [{ tag_names: 1 }, "idx_tag_names"],                               // multikey: "has all these tags"
    [{ categories: 1 }, "idx_categories"],
    [{ supported_languages: 1 }, "idx_languages"],
    [{ full_audio_languages: 1 }, "idx_full_audio"]
];
for (const [key, name] of indexes) db.games.createIndex(key, { name });
db.games.getIndexes().forEach((i) => print(`   ${i.name} ${JSON.stringify(i.key)}`));
const st = db.games.stats();
print(`   data ${(st.storageSize / 1048576).toFixed(1)} MB, indexes ${(st.totalIndexSize / 1048576).toFixed(1)} MB`);
print("Done. Now replace routes/games.js and restart the server.");
