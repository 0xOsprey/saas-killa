-- Audited unchanged. One enum, one table, its foreign key and its index, in
-- that order, so nothing references a type or a table that does not exist yet.
-- Replayed from empty over 0000-0005 on a scratch `migration_probe` database
-- with ON_ERROR_STOP=1 before being applied here.
--
-- `started_by_id` is ON DELETE SET NULL rather than CASCADE: a run is the
-- record of what we sent Accelevents, and deleting the organizer who pressed
-- the button must not delete the evidence.
CREATE TYPE "public"."integration_run_status" AS ENUM('running', 'ok', 'failed');--> statement-breakpoint
CREATE TABLE "integration_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target" text DEFAULT 'accelevents' NOT NULL,
	"mode" text NOT NULL,
	"status" "integration_run_status" DEFAULT 'running' NOT NULL,
	"base_url" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"speaker_count" integer DEFAULT 0 NOT NULL,
	"session_count" integer DEFAULT 0 NOT NULL,
	"track_count" integer DEFAULT 0 NOT NULL,
	"requests" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"started_by_id" uuid
);
--> statement-breakpoint
ALTER TABLE "integration_runs" ADD CONSTRAINT "integration_runs_started_by_id_users_id_fk" FOREIGN KEY ("started_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "integration_runs_started_idx" ON "integration_runs" USING btree ("started_at");