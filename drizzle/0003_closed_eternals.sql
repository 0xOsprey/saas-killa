-- Audited, and this one needed no reordering: CREATE TYPE precedes the table
-- that names it, the two foreign keys follow the table, and nothing here adds a
-- NOT NULL column to a table that already holds rows. Replayed from empty over
-- 0000 through 0002 on a scratch database before being applied.

CREATE TYPE "public"."upload_kind" AS ENUM('headshot', 'slides', 'poster', 'document');--> statement-breakpoint
CREATE TABLE "uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"submission_id" uuid,
	"kind" "upload_kind" NOT NULL,
	"filename" text NOT NULL,
	"stored_name" text NOT NULL,
	"content_type" text NOT NULL,
	"bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "uploads_owner_idx" ON "uploads" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "uploads_submission_idx" ON "uploads" USING btree ("submission_id");