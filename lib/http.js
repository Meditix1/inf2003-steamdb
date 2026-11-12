// =========================================================
// Small helpers shared by the MySQL user-data routes
// =========================================================

// Wrap an async route so thrown errors reach sendError instead of crashing
function handle(fn) {
    return (req, res) => {
        Promise.resolve(fn(req, res)).catch((err) => sendError(res, err));
    };
}

// An error we raise on purpose, with an HTTP status
class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

// Positive integer id from a URL param or body field, or a 400
function parseId(value, label = "id") {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0 || n > 2147483647) {
        throw new HttpError(400, `Invalid ${label}`);
    }
    return n;
}

// "1,2,3" -> [1, 2, 3], capped so a URL can't build a huge IN (...)
function parseIdList(value, max = 100) {
    if (!value) return [];
    return [...new Set(
        String(value)
            .split(",")
            .map((v) => Number(v))
            .filter((n) => Number.isInteger(n) && n > 0 && n <= 2147483647)
    )].slice(0, max);
}

// Turn MySQL constraint errors into meaningful HTTP responses.
// The database enforces the rules; the API just explains them.
function sendError(res, err) {
    if (err instanceof HttpError) {
        return res.status(err.status).json({ message: err.message });
    }

    switch (err.code) {
        // FK: the game (or other parent row) doesn't exist. MySQL sends the shorter
        // code when the connecting user (e.g. steamdb_app) has limited privileges.
        case "ER_NO_REFERENCED_ROW_2":
        case "ER_NO_REFERENCED_ROW":
            return res.status(404).json({ message: "Game not found" });
        case "ER_DUP_ENTRY":                // PK / UNIQUE: already added
            return res.status(409).json({ message: "Already exists" });
        case "ER_CHECK_CONSTRAINT_VIOLATED":
            return res.status(400).json({ message: "Value out of range" });
        case "ER_SIGNAL_EXCEPTION":         // a trigger refused the change (scripts/setup/mysql_views_triggers.sql)
            return res.status(409).json({ message: err.sqlMessage });
        case "ER_DATA_TOO_LONG":
            return res.status(400).json({ message: "Text is too long" });
    }

    console.error(err);
    res.status(500).json({ message: "Something went wrong" });
}

// Run several statements as one transaction on a single pooled connection
async function inTransaction(pool, work) {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const result = await work(conn);
        await conn.commit();
        return result;
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

module.exports = { handle, HttpError, parseId, parseIdList, sendError, inTransaction };
