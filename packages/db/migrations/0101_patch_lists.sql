CREATE TABLE "patch_rows" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"stage_box_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"channel" integer NOT NULL,
	"source" text DEFAULT '' NOT NULL,
	"device" text DEFAULT '' NOT NULL,
	"cable" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patch_rows_direction" CHECK ("patch_rows"."direction" in ('input', 'output')),
	CONSTRAINT "patch_rows_channel" CHECK ("patch_rows"."channel" >= 1)
);
--> statement-breakpoint
CREATE TABLE "stage_boxes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "patch_rows" ADD CONSTRAINT "patch_rows_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patch_rows" ADD CONSTRAINT "patch_rows_stage_box_id_stage_boxes_id_fk" FOREIGN KEY ("stage_box_id") REFERENCES "public"."stage_boxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_boxes" ADD CONSTRAINT "stage_boxes_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_boxes" ADD CONSTRAINT "stage_boxes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "patch_rows_channel_idx" ON "patch_rows" USING btree ("stage_box_id","direction","channel");--> statement-breakpoint
CREATE INDEX "patch_rows_box_idx" ON "patch_rows" USING btree ("organisation_id","stage_box_id");--> statement-breakpoint
CREATE INDEX "stage_boxes_project_idx" ON "stage_boxes" USING btree ("organisation_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stage_boxes_name_idx" ON "stage_boxes" USING btree ("project_id","name");