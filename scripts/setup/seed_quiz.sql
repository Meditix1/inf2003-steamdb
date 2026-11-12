-- =========================================================
-- Recommendation quiz: 6 questions, each answer points at a Steam genre
-- (genre_name must match genres in MongoDB `games`). Safe to re-run:
-- it clears old questions, options and answers first (preferences are rebuilt
-- the next time someone takes the quiz).
--   docker exec -i -e MYSQL_PWD="$P" steamdb-mysql mysql -u root < scripts/setup/seed_quiz.sql
-- =========================================================
USE steamdb;

START TRANSACTION;
DELETE FROM quiz_response;
DELETE FROM user_genre_preference;
DELETE FROM quiz_option;
DELETE FROM quiz_question;

INSERT INTO quiz_question (question_id, prompt, display_order) VALUES
 (1, 'It''s Friday night. What sounds best?', 1),
 (2, 'Pick a pace.', 2),
 (3, 'What do you want from a game''s story?', 3),
 (4, 'Who are you playing with?', 4),
 (5, 'Pick a setting.', 5),
 (6, 'What keeps you coming back?', 6);

INSERT INTO quiz_option (question_id, label, genre_name) VALUES
 (1, 'Something fast where reflexes matter',          'Action'),
 (1, 'Exploring a new world at my own speed',         'Adventure'),
 (1, 'Planning a long campaign',                      'Strategy'),
 (1, 'A short relaxing session',                      'Casual'),
 (2, 'Non-stop action',                               'Action'),
 (2, 'Slow and thoughtful',                           'Strategy'),
 (2, 'Steady progress, levelling up',                 'RPG'),
 (2, 'Whatever: I just want to unwind',               'Casual'),
 (3, 'A long epic with characters I care about',      'RPG'),
 (3, 'A mystery I uncover myself',                    'Adventure'),
 (3, 'Story? I make my own',                          'Simulation'),
 (3, 'Something weird and original',                  'Indie'),
 (4, 'Just me',                                       'Adventure'),
 (4, 'Friends, competing',                            'Sports'),
 (4, 'Friends, on the same team',                     'Action'),
 (4, 'Lots of people online',                         'Massively Multiplayer'),
 (5, 'A race track',                                  'Racing'),
 (5, 'A farm, a city or a business to run',           'Simulation'),
 (5, 'A fantasy kingdom',                             'RPG'),
 (5, 'A stadium',                                     'Sports'),
 (6, 'Getting better at it every time',               'Action'),
 (6, 'Building something big',                        'Simulation'),
 (6, 'Small, creative games from small teams',        'Indie'),
 (6, 'Outsmarting opponents',                         'Strategy');
COMMIT;

SELECT q.question_id, q.prompt, COUNT(o.option_id) AS options
FROM quiz_question q JOIN quiz_option o ON o.question_id = q.question_id
GROUP BY q.question_id, q.prompt ORDER BY q.display_order;
