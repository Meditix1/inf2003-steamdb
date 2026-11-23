# SteamDB (INF2003 Database Systems, Team P4_11)

A Steam games web application on two databases: MySQL 8.4 (accounts, library, wishlist, reviews, moderation, quiz) and MongoDB 8 (game catalogue and user collections), with a Node.js / Express 5 back end. The project also includes six benchmark experiments (P1 to P6) that compare the two databases.

## Quick start

Full step-by-step instructions are in the user manual: [docs/User_Manual.pdf](docs/User_Manual.pdf). In short:

1. `npm install`
2. Start MySQL 8.4 and MongoDB 8 in Docker as `steamdb-mysql` and `steamdb-mongodb` (manual, Section 3).
3. Create the schema, views, triggers and quiz: `scripts/setup/mysql_schema.sql`, `mysql_views_triggers.sql`, `seed_quiz.sql` (Section 4).
4. Load the data from `data/` (`games.json.gz` into MongoDB, `game_ids.txt` into MySQL `game`), then run `scripts/setup/clean_games.js` and `mongo_collections_setup.js` (Section 5).
5. Create a `.env` file with the database settings (Section 6; it is not committed because it holds passwords).
6. `node server.js`, then open http://127.0.0.1:3000 (Section 7).

## Folders

| Folder | Contents |
| --- | --- |
| `server.js`, `routes/`, `db/`, `lib/`, `middleware/` | Express server, one route file per feature, database connections |
| `public/` | Front end (HTML, CSS, JavaScript) |
| `scripts/setup/` | Schema, views, triggers, quiz seed, MongoDB clean-up and validators |
| `scripts/` | Demo data seeding (`seed_demo_data.js`) and benchmark data builders |
| `scripts/bench/`, `bench/results/` | Benchmark harness P1 to P6 and saved results (JSON, CSV, query plans) |
| `data/` | Cleaned game data: 50,000 games (`games.json.gz`) and their AppIDs (`game_ids.txt`) |

Data source: Kaggle "Steam Games Dataset" (fronkongames/steam-games-dataset), cleaned to 50,000 valid games.
