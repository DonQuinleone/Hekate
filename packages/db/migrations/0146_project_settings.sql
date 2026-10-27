ALTER TYPE "public"."audit_action" ADD VALUE 'project.asset_security';--> statement-breakpoint
CREATE TABLE "project_tool_exceptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" text,
	"guest_id" uuid,
	"group_id" uuid,
	"tools" text[] NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_tool_exceptions_one_subject" CHECK (num_nonnulls("project_tool_exceptions"."user_id", "project_tool_exceptions"."guest_id", "project_tool_exceptions"."group_id") = 1)
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "asset_policy" jsonb;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "workflow_notices" jsonb;--> statement-breakpoint
ALTER TABLE "project_tool_exceptions" ADD CONSTRAINT "project_tool_exceptions_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tool_exceptions" ADD CONSTRAINT "project_tool_exceptions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tool_exceptions" ADD CONSTRAINT "project_tool_exceptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tool_exceptions" ADD CONSTRAINT "project_tool_exceptions_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tool_exceptions" ADD CONSTRAINT "project_tool_exceptions_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tool_exceptions" ADD CONSTRAINT "project_tool_exceptions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_tool_exceptions_user_idx" ON "project_tool_exceptions" USING btree ("organisation_id","project_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_tool_exceptions_guest_idx" ON "project_tool_exceptions" USING btree ("organisation_id","project_id","guest_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_tool_exceptions_group_idx" ON "project_tool_exceptions" USING btree ("organisation_id","project_id","group_id");