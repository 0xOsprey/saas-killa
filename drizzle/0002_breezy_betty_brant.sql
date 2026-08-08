-- Hand-reordered after generation, twice over.
--
-- drizzle-kit emitted `ADD CONSTRAINT ... PRIMARY KEY("round_id", ...)` before
-- the `ADD COLUMN "round_id"` that constraint names, which is the same ordering
-- bug that broke 0001. It also emitted both new columns as `NOT NULL` with no
-- default, which cannot apply to a table that already holds rows.
--
-- The fix for the second half is a backfill round: every assignment and review
-- that existed before rounds did belongs to round one, because that is what it
-- was. The insert is guarded so a fresh database that has not seeded yet gets
-- exactly one, and the seed truncates and writes its own regardless.

CREATE TYPE "public"."question_kind" AS ENUM('short_text', 'long_text', 'select', 'checkbox', 'url');--> statement-breakpoint
CREATE TABLE "form_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prompt" text NOT NULL,
	"help_text" text,
	"kind" "question_kind" DEFAULT 'short_text' NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"formats" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"track_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"show_if_question_id" uuid,
	"show_if_value" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_rounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"opens_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "submission_answers" (
	"submission_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"value" text NOT NULL,
	CONSTRAINT "submission_answers_submission_id_question_id_pk" PRIMARY KEY("submission_id","question_id")
);
--> statement-breakpoint
INSERT INTO "review_rounds" ("name", "position")
	SELECT 'Round 1', 0 WHERE NOT EXISTS (SELECT 1 FROM "review_rounds");--> statement-breakpoint
ALTER TABLE "review_assignments" ADD COLUMN "round_id" uuid;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "round_id" uuid;--> statement-breakpoint
UPDATE "review_assignments" SET "round_id" =
	(SELECT "id" FROM "review_rounds" ORDER BY "position", "created_at" LIMIT 1)
	WHERE "round_id" IS NULL;--> statement-breakpoint
UPDATE "reviews" SET "round_id" =
	(SELECT "id" FROM "review_rounds" ORDER BY "position", "created_at" LIMIT 1)
	WHERE "round_id" IS NULL;--> statement-breakpoint
ALTER TABLE "review_assignments" ALTER COLUMN "round_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ALTER COLUMN "round_id" SET NOT NULL;--> statement-breakpoint
DROP INDEX "reviews_submission_reviewer_idx";--> statement-breakpoint
ALTER TABLE "review_assignments" DROP CONSTRAINT "review_assignments_submission_id_reviewer_id_pk";--> statement-breakpoint
ALTER TABLE "review_assignments" ADD CONSTRAINT "review_assignments_round_id_submission_id_reviewer_id_pk" PRIMARY KEY("round_id","submission_id","reviewer_id");--> statement-breakpoint
ALTER TABLE "submission_authors" ADD COLUMN "can_edit" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "submission_answers" ADD CONSTRAINT "submission_answers_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_answers" ADD CONSTRAINT "submission_answers_question_id_form_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."form_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "form_questions_position_idx" ON "form_questions" USING btree ("position");--> statement-breakpoint
CREATE INDEX "submission_answers_question_idx" ON "submission_answers" USING btree ("question_id");--> statement-breakpoint
ALTER TABLE "review_assignments" ADD CONSTRAINT "review_assignments_round_id_review_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."review_rounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_round_id_review_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."review_rounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_round_submission_reviewer_idx" ON "reviews" USING btree ("round_id","submission_id","reviewer_id");
