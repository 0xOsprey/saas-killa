CREATE TYPE "public"."criterion_kind" AS ENUM('numeric', 'select', 'text');--> statement-breakpoint
CREATE TABLE "review_conflicts" (
	"round_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"reason" text,
	"declared_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_conflicts_round_id_submission_id_reviewer_id_pk" PRIMARY KEY("round_id","submission_id","reviewer_id")
);
--> statement-breakpoint
CREATE TABLE "round_criteria" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"round_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"kind" "criterion_kind" DEFAULT 'numeric' NOT NULL,
	"help_text" text,
	"scale_min" integer DEFAULT 1 NOT NULL,
	"scale_max" integer DEFAULT 5 NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"weight" integer DEFAULT 1 NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "round_reviewers" (
	"round_id" uuid NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "round_reviewers_round_id_reviewer_id_pk" PRIMARY KEY("round_id","reviewer_id")
);
--> statement-breakpoint
ALTER TABLE "review_rounds" ADD COLUMN "blind" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "answers" jsonb;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "weighted_score" real;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "override_score" integer;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "override_reason" text;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "overridden_by_id" uuid;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "overridden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "review_conflicts" ADD CONSTRAINT "review_conflicts_round_id_review_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."review_rounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_conflicts" ADD CONSTRAINT "review_conflicts_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_conflicts" ADD CONSTRAINT "review_conflicts_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "round_criteria" ADD CONSTRAINT "round_criteria_round_id_review_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."review_rounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "round_reviewers" ADD CONSTRAINT "round_reviewers_round_id_review_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."review_rounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "round_reviewers" ADD CONSTRAINT "round_reviewers_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_conflicts_reviewer_idx" ON "review_conflicts" USING btree ("reviewer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "round_criteria_round_key_idx" ON "round_criteria" USING btree ("round_id","key");--> statement-breakpoint
CREATE INDEX "round_criteria_round_position_idx" ON "round_criteria" USING btree ("round_id","position");--> statement-breakpoint
CREATE INDEX "round_reviewers_reviewer_idx" ON "round_reviewers" USING btree ("reviewer_id");--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_overridden_by_id_users_id_fk" FOREIGN KEY ("overridden_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Every round that predates per-round scorecards graded against the four
-- criteria hardcoded in src/lib/rubric.ts. Seeding them as real rows is what
-- keeps the grades already filed readable: reviews.rubric is keyed by these
-- same four keys, and a round with no criteria would render every stored score
-- as a value with no field to belong to.
INSERT INTO "round_criteria" ("round_id", "key", "label", "kind", "help_text", "scale_min", "scale_max", "weight", "position")
SELECT r."id", c."key", c."label", 'numeric'::"criterion_kind", c."help_text", 1, 5, 1, c."position"
FROM "review_rounds" r
CROSS JOIN (VALUES
  ('clarity', 'Clarity', 'Is the abstract specific about what the audience will see and learn?', 0),
  ('originality', 'Originality', 'Does this cover ground the audience has not already heard?', 1),
  ('relevance', 'Relevance', 'Does it fit the track and the stated audience level?', 2),
  ('credibility', 'Credibility', 'Does the proposal show the speaker has actually done this work?', 3)
) AS c("key", "label", "help_text", "position")
ON CONFLICT DO NOTHING;
