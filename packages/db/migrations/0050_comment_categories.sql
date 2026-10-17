CREATE TYPE "public"."category_handling" AS ENUM('normal', 'deferred', 'information');--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'assigned';--> statement-breakpoint
CREATE TABLE "comment_categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"handling" "category_handling" DEFAULT 'normal' NOT NULL,
	"stage" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "category_id" uuid;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "deferred_to" text;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "assignee_id" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "categories_seeded" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "comment_categories" ADD CONSTRAINT "comment_categories_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_categories" ADD CONSTRAINT "comment_categories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comment_categories_project_idx" ON "comment_categories" USING btree ("organisation_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "comment_categories_name_idx" ON "comment_categories" USING btree ("project_id",lower("name"));--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_category_id_comment_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."comment_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;