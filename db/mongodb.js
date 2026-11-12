const { MongoClient } = require("mongodb");

if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is missing from .env");
}

const client = new MongoClient(process.env.MONGO_URI);

let db;

async function connectMongo() {
    await client.connect();
    db = client.db(process.env.MONGO_DATABASE);

    console.log("MongoDB connected");
}

function getMongoDB() {
    return db;
}

module.exports = {
    connectMongo,
    getMongoDB
};