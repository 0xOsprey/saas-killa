-- Audited unchanged. One new table, its foreign key and its unique index, in
-- that order, so nothing references a table that does not exist yet. Replayed
-- from empty over 0000-0004 on a scratch `migration_probe` database with
-- ON_ERROR_STOP=1 before being applied here.
--
-- `body` is the HTML as the organizer typed it, not as it renders. Sanitising
-- on write would freeze every saved page against a later tightening of the
-- allowlist and would hand an author the sanitiser's output as their draft.
CREATE TABLE "portal_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"body" text DEFAULT '' NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"updated_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "portal_pages" ADD CONSTRAINT "portal_pages_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "portal_pages_slug_idx" ON "portal_pages" USING btree ("slug");