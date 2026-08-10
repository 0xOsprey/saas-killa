CREATE TYPE "public"."file_export_status" AS ENUM('queued', 'generating', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "file_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requested_by_id" uuid NOT NULL,
	"status" "file_export_status" DEFAULT 'queued' NOT NULL,
	"grouping" text DEFAULT 'session' NOT NULL,
	"upload_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"stored_name" text,
	"file_count" integer DEFAULT 0 NOT NULL,
	"bytes" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "upload_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"series_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "uploads" ADD COLUMN "series_id" uuid;--> statement-breakpoint
ALTER TABLE "file_exports" ADD CONSTRAINT "file_exports_requested_by_id_users_id_fk" FOREIGN KEY ("requested_by_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_comments" ADD CONSTRAINT "upload_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "file_exports_requested_idx" ON "file_exports" USING btree ("requested_by_id","created_at");--> statement-breakpoint
CREATE INDEX "upload_comments_series_idx" ON "upload_comments" USING btree ("series_id","created_at");--> statement-breakpoint
CREATE INDEX "uploads_series_idx" ON "uploads" USING btree ("series_id");