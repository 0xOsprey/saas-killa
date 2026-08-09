-- One title per speaker, case-insensitively. This fails rather than deduping
-- if the table already holds a collision, which is deliberate: choosing which
-- of two identical proposals to keep is an organizer's call, not a migration's.
-- To find them first:
--
--   select speaker_id, lower(title), count(*) from submissions
--   group by 1, 2 having count(*) > 1;
CREATE UNIQUE INDEX "submissions_speaker_title_idx" ON "submissions" USING btree ("speaker_id",lower("title"));
