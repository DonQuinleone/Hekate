CREATE TABLE "workspace_categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"name" text NOT NULL,
	"handling" "category_handling" DEFAULT 'normal' NOT NULL,
	"stage" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD COLUMN "method" text;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "categories_seeded" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_categories" ADD CONSTRAINT "workspace_categories_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_categories_name_idx" ON "workspace_categories" USING btree ("organisation_id",lower("name"));