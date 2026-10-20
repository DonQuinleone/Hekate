ALTER TABLE "stage_plans" ADD COLUMN "underlay_file_id" uuid;--> statement-breakpoint
ALTER TABLE "stage_plans" ADD COLUMN "underlay_page" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "stage_plans" ADD COLUMN "underlay_x" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "stage_plans" ADD COLUMN "underlay_y" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "stage_plans" ADD COLUMN "underlay_width" double precision;--> statement-breakpoint
ALTER TABLE "stage_plans" ADD COLUMN "underlay_opacity" double precision DEFAULT 0.5 NOT NULL;--> statement-breakpoint
ALTER TABLE "stage_plans" ADD CONSTRAINT "stage_plans_underlay_file_id_files_id_fk" FOREIGN KEY ("underlay_file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_plans" ADD CONSTRAINT "stage_plans_underlay" CHECK ("stage_plans"."underlay_opacity" between 0 and 1 and "stage_plans"."underlay_page" >= 1 and ("stage_plans"."underlay_width" is null or "stage_plans"."underlay_width" > 0));