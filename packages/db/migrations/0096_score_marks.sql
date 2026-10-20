CREATE TABLE "score_mark_categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"colour" text NOT NULL,
	"key" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "score_marks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"track_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"page" integer NOT NULL,
	"x" double precision NOT NULL,
	"y" double precision NOT NULL,
	"width" double precision,
	"height" double precision,
	"points" jsonb,
	"bar_from" integer,
	"bar_to" integer,
	"text" text,
	"category_id" uuid,
	"takes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fixed_by" integer,
	"resolved_at" timestamp with time zone,
	"from_take" integer,
	"to_take" integer,
	"overdub" boolean DEFAULT false NOT NULL,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "score_categories_seeded" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "score_mark_categories" ADD CONSTRAINT "score_mark_categories_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "score_mark_categories" ADD CONSTRAINT "score_mark_categories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "score_marks" ADD CONSTRAINT "score_marks_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "score_marks" ADD CONSTRAINT "score_marks_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "score_marks" ADD CONSTRAINT "score_marks_category_id_score_mark_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."score_mark_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "score_marks" ADD CONSTRAINT "score_marks_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "score_mark_categories_project_idx" ON "score_mark_categories" USING btree ("organisation_id","project_id");--> statement-breakpoint
CREATE INDEX "score_marks_track_idx" ON "score_marks" USING btree ("organisation_id","track_id","page");