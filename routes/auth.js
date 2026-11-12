const express = require("express");
const bcrypt = require("bcrypt");
const mysql = require("../db/mysql");

const router = express.Router();


// ==========================
// REGISTER
// ==========================
router.post("/register", async (req, res) => {
    try {
        const { username, email, password } = req.body;

        if (!username || !email || !password) {
            return res.status(400).json({
                message: "All fields are required"
            });
        }

        if (password.length < 8) {
            return res.status(400).json({
                message: "Password must be at least 8 characters"
            });
        }

        // Check whether username/email already exists
        const [existingUsers] = await mysql.query(
            `SELECT user_id
             FROM users
             WHERE username = ? OR email = ?`,
            [username, email]
        );

        if (existingUsers.length > 0) {
            return res.status(409).json({
                message: "Username or email already exists"
            });
        }

        // Hash password
        const passwordHash = await bcrypt.hash(password, 12);

        // Create user
        const [result] = await mysql.query(
            `INSERT INTO users
                (username, email, password_hash)
             VALUES (?, ?, ?)`,
            [username, email, passwordHash]
        );

        res.status(201).json({
            message: "Account created successfully",
            userId: result.insertId
        });

    } catch (error) {
        console.error("Registration error:", error);

        res.status(500).json({
            message: "Server error"
        });
    }
});


// ==========================
// LOGIN
// ==========================
router.post("/login", async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({
                message: "Email and password are required"
            });
        }

        const [users] = await mysql.query(
            `SELECT user_id, username, email, password_hash
             FROM users
             WHERE email = ? AND is_deleted = 0`,
            [email]
        );

        if (users.length === 0) {
            return res.status(401).json({
                message: "Invalid email or password"
            });
        }

        const user = users[0];

        const passwordMatches = await bcrypt.compare(
            password,
            user.password_hash
        );

        if (!passwordMatches) {
            return res.status(401).json({
                message: "Invalid email or password"
            });
        }

        // Store user identity in session
        req.session.user = {
            userId: user.user_id,
            username: user.username,
            email: user.email
        };

        res.json({
            message: "Login successful",
            user: req.session.user
        });

    } catch (error) {
        console.error("Login error:", error);

        res.status(500).json({
            message: "Server error"
        });
    }
});


// ==========================
// CURRENT USER
// ==========================
router.get("/me", (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({
            message: "Not logged in"
        });
    }

    res.json({
        user: req.session.user
    });
});


// ==========================
// LOGOUT
// ==========================
router.post("/logout", (req, res) => {
    req.session.destroy((error) => {
        if (error) {
            return res.status(500).json({
                message: "Could not log out"
            });
        }

        res.clearCookie("connect.sid");

        res.json({
            message: "Logged out successfully"
        });
    });
});


module.exports = router;