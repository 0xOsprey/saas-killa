CREATE TYPE "public"."content_status" AS ENUM('draft', 'pending', 'approved');--> statement-breakpoint
CREATE TYPE "public"."speaker_task_kind" AS ENUM('headshot', 'bio', 'slides', 'poster', 'confirm', 'other');--> statement-breakpoint
CREATE TYPE "public"."vote_channel" AS ENUM('committee', 'community');--> statement-breakpoint
CREATE TABLE "bookmarks" (
	"user_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookmarks_user_id_submission_id_pk" PRIMARY KEY("user_id","submission_id")
);
--> statement-breakpoint
CREATE TABLE "email_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"submission_id" uuid,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"delivered" boolean DEFAULT false NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evaluator_personas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"profession" text,
	"tone" text,
	"expertise" text,
	"weights" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_assignments" (
	"submission_id" uuid NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"due_at" timestamp with time zone,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_assignments_submission_id_reviewer_id_pk" PRIMARY KEY("submission_id","reviewer_id")
);
--> statement-breakpoint
CREATE TABLE "speaker_availability" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "speaker_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"submission_id" uuid,
	"kind" "speaker_task_kind" NOT NULL,
	"label" text NOT NULL,
	"due_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"last_reminded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "submission_authors" (
	"submission_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"affiliation" text,
	"is_presenter" boolean DEFAULT true NOT NULL,
	CONSTRAINT "submission_authors_submission_id_user_id_pk" PRIMARY KEY("submission_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "submission_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"editor_id" uuid NOT NULL,
	"field" text NOT NULL,
	"old_value" text,
	"new_value" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Hand-reordered: drizzle-kit emitted the widened primary key before the
-- column it names, which fails with 42703. The ADD COLUMNs now run first.
ALTER TABLE "award_nominees" ADD COLUMN "is_finalist" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "award_votes" ADD COLUMN "channel" "vote_channel" DEFAULT 'committee' NOT NULL;--> statement-breakpoint
ALTER TABLE "award_votes" ADD COLUMN "scores" jsonb;--> statement-breakpoint
ALTER TABLE "award_votes" DROP CONSTRAINT "award_votes_award_id_judge_id_pk";--> statement-breakpoint
ALTER TABLE "award_votes" ADD CONSTRAINT "award_votes_award_id_judge_id_channel_pk" PRIMARY KEY("award_id","judge_id","channel");--> statement-breakpoint
ALTER TABLE "awards" ADD COLUMN "public_voting" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "awards" ADD COLUMN "voting_opens_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "awards" ADD COLUMN "voting_closes_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "awards" ADD COLUMN "criteria" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "awards" ADD COLUMN "winner_override_reason" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "poster_embargo_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "persona_id" uuid;--> statement-breakpoint
ALTER TABLE "slots" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "board_number" text;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "content_status" "content_status" DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "keywords" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "locked_fields" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_log" ADD CONSTRAINT "email_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_log" ADD CONSTRAINT "email_log_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluator_personas" ADD CONSTRAINT "evaluator_personas_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_assignments" ADD CONSTRAINT "review_assignments_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_assignments" ADD CONSTRAINT "review_assignments_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "speaker_availability" ADD CONSTRAINT "speaker_availability_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "speaker_tasks" ADD CONSTRAINT "speaker_tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "speaker_tasks" ADD CONSTRAINT "speaker_tasks_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_authors" ADD CONSTRAINT "submission_authors_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_authors" ADD CONSTRAINT "submission_authors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_revisions" ADD CONSTRAINT "submission_revisions_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_revisions" ADD CONSTRAINT "submission_revisions_editor_id_users_id_fk" FOREIGN KEY ("editor_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_log_user_idx" ON "email_log" USING btree ("user_id","sent_at");--> statement-breakpoint
CREATE INDEX "review_assignments_reviewer_idx" ON "review_assignments" USING btree ("reviewer_id");--> statement-breakpoint
CREATE INDEX "speaker_availability_user_idx" ON "speaker_availability" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "speaker_tasks_user_idx" ON "speaker_tasks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "submission_authors_user_idx" ON "submission_authors" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "submission_revisions_submission_idx" ON "submission_revisions" USING btree ("submission_id","created_at");