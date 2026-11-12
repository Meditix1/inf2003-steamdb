require("dotenv").config();

const express = require("express");
const session = require("express-session");

const mysql = require("./db/mysql");
const { connectMongo } = require("./db/mongodb");

const authRoutes = require("./routes/auth");
const gameRoutes = require("./routes/games");

const app = express();

// Parse JSON requests
app.use(express.json());

// Parse HTML form data
app.use(express.urlencoded({ extended: true}));

// Sessions
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,

    cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: false,
        maxAge: 1000 * 60 * 60 * 24
    }
}));

// Static frontend
app.use(express.static("public"));

// API routes
app.use("/api/auth", authRoutes);
app.use("/api/games", gameRoutes);
app.use("/api/me",          require("./routes/me"));
app.use("/api/library",     require("./routes/library"));
app.use("/api/wishlist",    require("./routes/wishlist"));
app.use("/api/collections", require("./routes/collections"));
app.use("/api/reviews",     require("./routes/reviews"));
app.use("/api/moderation",  require("./routes/moderation"));
app.use("/api/catalogue",   require("./routes/catalogue"));
app.use("/api/account",     require("./routes/account"));
app.use("/api/quiz",        require("./routes/quiz"));
app.use("/api/rankings",    require("./routes/rankings"));

app.get("/api/test", (req, res) => {
    res.json({
        message: "SteamDB backend is working"
    });
});

async function startServer() {
    try {
        await mysql.query("SELECT 1");
        console.log("MySQL connected");

        await connectMongo();

        const port = process.env.PORT || 3000;

        app.listen(port, "127.0.0.1", () => {
            console.log(`Server running on port ${port}`);
        });

    } catch (error) {
        console.error("Startup failed:", error);
        process.exit(1);
    }
}

startServer();