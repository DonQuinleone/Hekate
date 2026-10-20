CREATE TABLE "stage_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"stage_plan_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"x" double precision NOT NULL,
	"y" double precision NOT NULL,
	"w" double precision NOT NULL,
	"h" double precision NOT NULL,
	"rotation" double precision DEFAULT 0 NOT NULL,
	"patch_row_id" uuid,
	"label_group" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stage_items_size" CHECK ("stage_items"."kind" = 'cable' or ("stage_items"."w" > 0 and "stage_items"."h" > 0))
);
--> statement-breakpoint
CREATE TABLE "stage_plans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"width" double precision NOT NULL,
	"depth" double precision NOT NULL,
	"grid" double precision DEFAULT 0.5 NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stage_plans_size" CHECK ("stage_plans"."width" > 0 and "stage_plans"."depth" > 0 and "stage_plans"."grid" > 0)
);
--> statement-breakpoint
ALTER TABLE "stage_items" ADD CONSTRAINT "stage_items_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_items" ADD CONSTRAINT "stage_items_stage_plan_id_stage_plans_id_fk" FOREIGN KEY ("stage_plan_id") REFERENCES "public"."stage_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_items" ADD CONSTRAINT "stage_items_patch_row_id_patch_rows_id_fk" FOREIGN KEY ("patch_row_id") REFERENCES "public"."patch_rows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_plans" ADD CONSTRAINT "stage_plans_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_plans" ADD CONSTRAINT "stage_plans_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stage_items_plan_idx" ON "stage_items" USING btree ("organisation_id","stage_plan_id");--> statement-breakpoint
CREATE INDEX "stage_items_patch_idx" ON "stage_items" USING btree ("patch_row_id");--> statement-breakpoint
CREATE INDEX "stage_plans_project_idx" ON "stage_plans" USING btree ("organisation_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stage_plans_name_idx" ON "stage_plans" USING btree ("project_id","name");