-- =========================================================
-- Views and triggers for the live steamdb database. Safe to re-run.
--   docker exec -i -e MYSQL_PWD="$P" steamdb-mysql mysql -u root < scripts/setup/mysql_views_triggers.sql
-- =========================================================
USE steamdb;

-- Review statistics per game (active reviews only). Used by the rankings page.
CREATE OR REPLACE VIEW v_game_review_stats AS
SELECT r.game_id,
       COUNT(*)                                  AS review_count,
       ROUND(AVG(r.rating), 2)                   AS avg_rating,
       ROUND(100 * AVG(r.rating >= 4), 1)        AS pct_positive,
       COALESCE(SUM(v.helpful), 0)               AS helpful_votes,
       MAX(r.created_at)                         AS last_review_at
FROM review r
LEFT JOIN (SELECT review_id, SUM(vote_type = 'helpful') AS helpful
           FROM review_vote GROUP BY review_id) v ON v.review_id = r.review_id
WHERE r.status = 'active'
GROUP BY r.game_id;

-- Open reports, one row per reported review. Used by the moderation page and its badge.
CREATE OR REPLACE VIEW v_moderation_queue AS
SELECT r.review_id, r.game_id, r.rating, r.body, r.created_at, r.status AS review_status,
       CASE WHEN u.user_id IS NULL OR u.is_deleted = 1 THEN NULL ELSE u.username END AS author,
       COUNT(*)                                                          AS report_count,
       GROUP_CONCAT(DISTINCT f.reason ORDER BY f.reason SEPARATOR ', ')  AS reasons,
       MIN(f.created_at)                                                 AS first_reported
FROM flag_report f
JOIN review r      ON r.review_id = f.review_id
LEFT JOIN users u  ON u.user_id = r.user_id
WHERE f.status = 'open'
GROUP BY r.review_id, u.user_id;

-- Per-user activity, excluding deleted accounts. Used for the top reviewers ranking.
CREATE OR REPLACE VIEW v_user_activity AS
SELECT u.user_id, u.username,
       (SELECT COUNT(*) FROM library l  WHERE l.user_id = u.user_id)                      AS games_owned,
       (SELECT COUNT(*) FROM review r   WHERE r.user_id = u.user_id AND r.status = 'active') AS reviews_written,
       (SELECT COUNT(*) FROM review r JOIN review_vote v ON v.review_id = r.review_id
         WHERE r.user_id = u.user_id AND v.vote_type = 'helpful')                          AS helpful_received
FROM users u
WHERE u.is_deleted = 0;

-- ---------- Triggers: rules the database enforces even if the app has a bug ----------
DROP TRIGGER IF EXISTS trg_review_vote_not_own;
DROP TRIGGER IF EXISTS trg_wishlist_not_owned;

DELIMITER //

-- Nobody can vote on their own review
CREATE TRIGGER trg_review_vote_not_own
BEFORE INSERT ON review_vote
FOR EACH ROW
BEGIN
    IF EXISTS (SELECT 1 FROM review WHERE review_id = NEW.review_id AND user_id = NEW.user_id) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'You can''t vote on your own review';
    END IF;
END//

-- A game you own can't also be on your wishlist
CREATE TRIGGER trg_wishlist_not_owned
BEFORE INSERT ON wishlist
FOR EACH ROW
BEGIN
    IF EXISTS (SELECT 1 FROM library WHERE user_id = NEW.user_id AND game_id = NEW.game_id) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This game is already in your library';
    END IF;
END//

DELIMITER ;

SHOW FULL TABLES WHERE Table_type = 'VIEW';
SHOW TRIGGERS;
