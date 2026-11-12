// =========================================================
// /api/account — account settings (MySQL) and account deletion (MySQL + MongoDB)
// =========================================================

const express = require("express");
const bcrypt = require("bcrypt");
const mysql = require("../db/mysql");
const { getMongoDB } = require("../db/mongodb");
const { requireLogin } = require("../middleware/auth");
const { handle, HttpError, inTransaction } = require("../lib/http");

const router = express.Router();
router.use(requireLogin);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function checkPassword(userId, password) {
    const [[user]] = await mysql.query(
        "SELECT password_hash FROM users WHERE user_id = ? AND is_deleted = 0", [userId]);
    if (!user) throw new HttpError(404, "Account not found");
    if (typeof password !== "string" || !(await bcrypt.compare(password, user.password_hash))) {
        throw new HttpError(401, "Current password is incorrect");
    }
}


// GET /api/account
router.get("/", handle(async (req, res) => {
    const [[user]] = await mysql.query(
        "SELECT username, email, role, created_at FROM users WHERE user_id = ? AND is_deleted = 0", [req.userId]);
    if (!user) throw new HttpError(404, "Account not found");
    res.json(user);
}));


// PATCH /api/account  { username?, email? }
router.patch("/", handle(async (req, res) => {
    const sets = [], params = [];

    if (req.body?.username !== undefined) {
        const username = String(req.body.username).trim();
        if (!/^[A-Za-z0-9_.-]{3,50}$/.test(username)) {
            throw new HttpError(400, "Username must be 3-50 letters, numbers, dots, dashes or underscores");
        }
        sets.push("username = ?"); params.push(username);
    }
    if (req.body?.email !== undefined) {
        const email = String(req.body.email).trim().toLowerCase();
        if (!EMAIL.test(email) || email.length > 255) throw new HttpError(400, "Enter a valid email address");
        sets.push("email = ?"); params.push(email);
    }
    if (!sets.length) throw new HttpError(400, "Nothing to update");

    try {
        await mysql.query(`UPDATE users SET ${sets.join(", ")} WHERE user_id = ? AND is_deleted = 0`, [...params, req.userId]);
    } catch (err) {
        if (err.code === "ER_DUP_ENTRY") throw new HttpError(409, "That username or email is already taken");
        throw err;
    }

    // Keep the session's copy in step, so the header shows the new name
    const [[user]] = await mysql.query("SELECT username, email FROM users WHERE user_id = ?", [req.userId]);
    req.session.user = { ...req.session.user, username: user.username, email: user.email };
    res.json(user);
}));


// PUT /api/account/password  { currentPassword, newPassword }
router.put("/password", handle(async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (typeof newPassword !== "string" || newPassword.length < 8) {
        throw new HttpError(400, "New password must be at least 8 characters");
    }
    await checkPassword(req.userId, currentPassword);

    const hash = await bcrypt.hash(newPassword, 12);
    await mysql.query("UPDATE users SET password_hash = ? WHERE user_id = ?", [hash, req.userId]);
    res.json({ updated: true });
}));


// DELETE /api/account  { password }
// Soft delete: the row stays (is_deleted = 1, deleted_at = now) so reviews keep
// their history and show "[deleted user]". Personal data is removed:
//   - username/email replaced, so they can be reused and nothing identifies the person
//   - library, wishlist, quiz answers and preferences deleted (one MySQL transaction)
//   - their MongoDB collections deleted. That's a second database, so it can't be in
//     the same transaction: it runs after the commit and any failure is logged.
router.delete("/", handle(async (req, res) => {
    await checkPassword(req.userId, req.body?.password);
    const userId = req.userId;

    await inTransaction(mysql, async (conn) => {
        await conn.query(`
            UPDATE users
            SET is_deleted = 1, deleted_at = NOW(),
                username = CONCAT('deleted_', user_id),
                email = CONCAT('deleted_', user_id, '@deleted.invalid'),
                password_hash = '!'
            WHERE user_id = ? AND is_deleted = 0`, [userId]);
        await conn.query("DELETE FROM library WHERE user_id = ?", [userId]);
        await conn.query("DELETE FROM wishlist WHERE user_id = ?", [userId]);
        await conn.query("DELETE FROM quiz_response WHERE user_id = ?", [userId]);
        await conn.query("DELETE FROM user_genre_preference WHERE user_id = ?", [userId]);
    });

    let collectionsRemoved = null;
    try {
        ({ deletedCount: collectionsRemoved } = await getMongoDB().collection("collections").deleteMany({ user_id: userId }));
    } catch (err) {
        console.error(`Account ${userId} deleted, but its MongoDB collections were not:`, err.message);
    }

    req.session.destroy(() => {
        res.clearCookie("connect.sid");
        res.json({ deleted: true, collectionsRemoved });
    });
}));


module.exports = router;
