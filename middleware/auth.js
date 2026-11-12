// =========================================================
// Login and role checks for the user-data routes
// =========================================================

const mysql = require("../db/mysql");

// routes/auth.js stores the logged-in user at login as
//   req.session.user = { userId, username, email }
function sessionUserId(req) {
    const id = req.session?.user?.userId;
    const n = Number(id);
    return Number.isInteger(n) && n > 0 ? n : null;
}

function requireLogin(req, res, next) {
    const userId = sessionUserId(req);
    if (!userId) {
        return res.status(401).json({ message: "Please log in first" });
    }
    req.userId = userId;
    next();
}

// Reads the role from the database on each request (not from the session),
// so promoting or demoting a user takes effect without them logging out.
function requireRole(...roles) {
    return async (req, res, next) => {
        const userId = sessionUserId(req);
        if (!userId) {
            return res.status(401).json({ message: "Please log in first" });
        }
        try {
            const [[user]] = await mysql.query(
                "SELECT role FROM users WHERE user_id = ?", [userId]
            );
            if (!user || !roles.includes(user.role)) {
                return res.status(403).json({ message: "You don't have access to this" });
            }
            req.userId = userId;
            req.userRole = user.role;
            next();
        } catch (err) {
            console.error(err);
            res.status(500).json({ message: "Something went wrong" });
        }
    };
}

module.exports = { sessionUserId, requireLogin, requireRole };