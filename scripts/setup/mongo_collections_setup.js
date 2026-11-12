// =========================================================
// MongoDB setup for user collections (run once, safe to re-run)
//
// 1. Drops the empty leftover collections that duplicated MySQL tables.
//    A collection is only dropped if it has 0 documents.
// 2. Adds a $jsonSchema validator to `collections`.
// 3. Creates its indexes.
//
// Run on the VM (from ~/steamdb-web):
//   docker cp scripts/setup/mongo_collections_setup.js steamdb-mongodb:/tmp/setup.js
//   docker exec -it steamdb-mongodb mongosh -u admin -p --authenticationDatabase admin steamdb --file /tmp/setup.js
// =========================================================

const LEFTOVERS = ["users", "library_entries", "wishlist_entries", "quiz_questions", "quiz_attempts", "collection_items"];
const existing = db.getCollectionNames();

for (const name of LEFTOVERS) {
    if (!existing.includes(name)) {
        print(`skip     ${name} (doesn't exist)`);
        continue;
    }
    const n = db.getCollection(name).countDocuments();
    if (n > 0) {
        print(`KEPT     ${name}: it has ${n} documents. Check what they are before dropping it by hand.`);
        continue;
    }
    db.getCollection(name).drop();
    print(`dropped  ${name}`);
}

// ---- Validator: the core shape is guaranteed, like a table definition ----
const validator = {
    $jsonSchema: {
        bsonType: "object",
        required: ["user_id", "name", "created_at", "updated_at", "games"],
        additionalProperties: false,
        properties: {
            _id: { bsonType: "objectId" },
            user_id: { bsonType: ["int", "long"], minimum: 1, description: "MySQL users.user_id of the owner" },
            name: { bsonType: "string", minLength: 1, maxLength: 150 },
            created_at: { bsonType: "date" },
            updated_at: { bsonType: "date" },
            games: {
                bsonType: "array",
                maxItems: 500,
                description: "Games in display order",
                items: {
                    bsonType: "object",
                    required: ["app_id", "added_at"],
                    additionalProperties: false,
                    properties: {
                        app_id: { bsonType: "string", pattern: "^[0-9]+$", description: "games._id" },
                        added_at: { bsonType: "date" }
                    }
                }
            }
        }
    }
};

if (existing.includes("collections")) {
    db.runCommand({ collMod: "collections", validator, validationLevel: "strict", validationAction: "error" });
    print("updated  collections: validator set");
} else {
    db.createCollection("collections", { validator, validationLevel: "strict", validationAction: "error" });
    print("created  collections with validator");
}

// ---- Indexes ----
// Unique name per user, ignoring case ("Cozy" = "cozy"), like MySQL's unique key
// under its case-insensitive collation. Its user_id prefix also serves "my collections".
db.collections.createIndex(
    { user_id: 1, name: 1 },
    { unique: true, name: "uq_user_name", collation: { locale: "en", strength: 2 } }
);
// Multikey index over the embedded array: "which collections contain game X"
db.collections.createIndex({ "games.app_id": 1 }, { name: "idx_games_app_id" });

print("\nindexes on collections:");
db.collections.getIndexes().forEach((i) => print(`  ${i.name}  ${JSON.stringify(i.key)}${i.unique ? "  unique" : ""}`));
print(`\ncollections now: ${db.getCollectionNames().sort().join(", ")}`);
