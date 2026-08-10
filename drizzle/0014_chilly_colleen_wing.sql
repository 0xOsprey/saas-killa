CREATE TABLE "contact_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"query" text NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_tags" (
	"contact_id" uuid NOT NULL,
	"tag" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_tags_contact_id_tag_pk" PRIMARY KEY("contact_id","tag")
);
--> statement-breakpoint
CREATE TABLE "pipeline_cards" (
	"contact_id" uuid PRIMARY KEY NOT NULL,
	"stage_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"from_stage_id" uuid,
	"to_stage_id" uuid,
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contact_notes" ADD CONSTRAINT "contact_notes_contact_id_users_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_notes" ADD CONSTRAINT "contact_notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_segments" ADD CONSTRAINT "contact_segments_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_contact_id_users_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_cards" ADD CONSTRAINT "pipeline_cards_contact_id_users_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_cards" ADD CONSTRAINT "pipeline_cards_stage_id_pipeline_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."pipeline_stages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_events" ADD CONSTRAINT "pipeline_events_contact_id_users_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_events" ADD CONSTRAINT "pipeline_events_from_stage_id_pipeline_stages_id_fk" FOREIGN KEY ("from_stage_id") REFERENCES "public"."pipeline_stages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_events" ADD CONSTRAINT "pipeline_events_to_stage_id_pipeline_stages_id_fk" FOREIGN KEY ("to_stage_id") REFERENCES "public"."pipeline_stages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_events" ADD CONSTRAINT "pipeline_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_notes_contact_idx" ON "contact_notes" USING btree ("contact_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_segments_name_idx" ON "contact_segments" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "contact_tags_tag_idx" ON "contact_tags" USING btree ("tag");--> statement-breakpoint
CREATE INDEX "pipeline_cards_stage_idx" ON "pipeline_cards" USING btree ("stage_id","position");--> statement-breakpoint
CREATE INDEX "pipeline_events_contact_idx" ON "pipeline_events" USING btree ("contact_id","created_at");--> statement-breakpoint
CREATE INDEX "pipeline_stages_position_idx" ON "pipeline_stages" USING btree ("position");