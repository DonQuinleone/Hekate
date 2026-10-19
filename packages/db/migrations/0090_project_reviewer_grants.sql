ALTER TYPE "public"."audit_action" ADD VALUE 'project.reviewer_grant' BEFORE 'guest.view';--> statement-breakpoint
CREATE TABLE "project_reviewer_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" text,
	"guest_id" uuid,
	"grant" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_reviewer_grants_one_person" CHECK (("project_reviewer_grants"."user_id" is null) <> ("project_reviewer_grants"."guest_id" is null))
);
--> statement-breakpoint
ALTER TABLE "project_reviewer_grants" ADD CONSTRAINT "project_reviewer_grants_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_reviewer_grants" ADD CONSTRAINT "project_reviewer_grants_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_reviewer_grants" ADD CONSTRAINT "project_reviewer_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_reviewer_grants" ADD CONSTRAINT "project_reviewer_grants_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_reviewer_grants_user_idx" ON "project_reviewer_grants" USING btree ("organisation_id","project_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_reviewer_grants_guest_idx" ON "project_reviewer_grants" USING btree ("organisation_id","project_id","guest_id");