ALTER TYPE "public"."audit_action" ADD VALUE 'project.guest_invite' BEFORE 'guest.view';--> statement-breakpoint
CREATE TABLE "project_guests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"guest_id" uuid NOT NULL,
	"note" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "step_names" jsonb;--> statement-breakpoint
ALTER TABLE "project_guests" ADD CONSTRAINT "project_guests_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_guests" ADD CONSTRAINT "project_guests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_guests" ADD CONSTRAINT "project_guests_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_guests" ADD CONSTRAINT "project_guests_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_guests_guest_idx" ON "project_guests" USING btree ("organisation_id","project_id","guest_id");--> statement-breakpoint
CREATE INDEX "project_guests_lookup_idx" ON "project_guests" USING btree ("guest_id");