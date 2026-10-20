CREATE TYPE "public"."schedule_row_kind" AS ENUM('slot', 'break', 'get-in', 'venue', 'custom');--> statement-breakpoint
CREATE TABLE "schedule_days" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"label" text NOT NULL,
	"date" date,
	"venue_id" uuid,
	"start" text DEFAULT '10:00' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_rows" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"day_id" uuid NOT NULL,
	"kind" "schedule_row_kind" NOT NULL,
	"start" text,
	"minutes" integer NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"all_repertoire" boolean DEFAULT false NOT NULL,
	"personnel" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"done" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_rows_minutes" CHECK ("schedule_rows"."minutes" between 0 and 1440)
);
--> statement-breakpoint
CREATE TABLE "schedule_slot_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"row_id" uuid NOT NULL,
	"work_id" uuid,
	"track_id" uuid,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "schedule_slot_items_one" CHECK (("schedule_slot_items"."work_id" is null) <> ("schedule_slot_items"."track_id" is null))
);
--> statement-breakpoint
ALTER TABLE "schedule_days" ADD CONSTRAINT "schedule_days_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_days" ADD CONSTRAINT "schedule_days_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_days" ADD CONSTRAINT "schedule_days_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_rows" ADD CONSTRAINT "schedule_rows_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_rows" ADD CONSTRAINT "schedule_rows_day_id_schedule_days_id_fk" FOREIGN KEY ("day_id") REFERENCES "public"."schedule_days"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_slot_items" ADD CONSTRAINT "schedule_slot_items_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_slot_items" ADD CONSTRAINT "schedule_slot_items_row_id_schedule_rows_id_fk" FOREIGN KEY ("row_id") REFERENCES "public"."schedule_rows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_slot_items" ADD CONSTRAINT "schedule_slot_items_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_slot_items" ADD CONSTRAINT "schedule_slot_items_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "schedule_days_project_idx" ON "schedule_days" USING btree ("organisation_id","project_id");--> statement-breakpoint
CREATE INDEX "schedule_rows_day_idx" ON "schedule_rows" USING btree ("organisation_id","day_id");--> statement-breakpoint
CREATE INDEX "schedule_slot_items_row_idx" ON "schedule_slot_items" USING btree ("organisation_id","row_id");