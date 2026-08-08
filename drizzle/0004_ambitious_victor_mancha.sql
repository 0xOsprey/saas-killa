-- Audited unchanged. Two additive columns on an existing table, no reordering
-- needed. Replayed from empty over 0000-0003 on a scratch `migration_probe`
-- database with ON_ERROR_STOP=1 before being applied here.
--
-- `schedule_notice_seq` defaults to 0 rather than being nullable: an existing
-- accepted row has had no invitation, and 0 is the RFC 5545 sequence a first
-- one carries, so the next notice sends 1 and every client treats it as new.
ALTER TABLE "submissions" ADD COLUMN "schedule_notice_key" text;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "schedule_notice_seq" integer DEFAULT 0 NOT NULL;