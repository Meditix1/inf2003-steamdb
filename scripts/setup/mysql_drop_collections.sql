-- =========================================================
-- User collections moved to MongoDB (`collections`), so the
-- MySQL tables go. Library, wishlist, reviews and quiz stay.
--
-- Run on the VM:
--   docker exec -i steamdb-mysql mysql -u root -p < scripts/setup/mysql_drop_collections.sql
-- =========================================================

USE steamdb;

-- What's about to be removed (test data only)
SELECT COUNT(*) AS collections_dropped FROM collection;
SELECT COUNT(*) AS collection_games_dropped FROM collection_game;

-- collection_game first: it has a foreign key to collection
DROP TABLE IF EXISTS collection_game;
DROP TABLE IF EXISTS collection;

SHOW TABLES;
