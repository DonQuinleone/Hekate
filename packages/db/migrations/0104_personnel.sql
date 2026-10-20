CREATE TABLE "personnel" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"role" text DEFAULT '' NOT NULL,
	"agreement" boolean DEFAULT false NOT NULL,
	"headphones" boolean DEFAULT false NOT NULL,
	"user_id" text,
	"guest_id" uuid,
	"seating" text DEFAULT '' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personnel_kind" CHECK ("personnel"."kind" in ('artist', 'ensemble', 'staff', 'other')),
	CONSTRAINT "personnel_link" CHECK ("personnel"."user_id" is null or "personnel"."guest_id" is null)
);
--> statement-breakpoint
CREATE TABLE "personnel_sections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"personnel_id" uuid NOT NULL,
	"name" text NOT NULL,
	"count" integer NOT NULL,
	"divisi" text DEFAULT '' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "personnel_sections_count" CHECK ("personnel_sections"."count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "section_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"name" text NOT NULL,
	"agreement" boolean DEFAULT false NOT NULL,
	"headphones" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "personnel" ADD CONSTRAINT "personnel_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel" ADD CONSTRAINT "personnel_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel" ADD CONSTRAINT "personnel_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel" ADD CONSTRAINT "personnel_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_sections" ADD CONSTRAINT "personnel_sections_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_sections" ADD CONSTRAINT "personnel_sections_personnel_id_personnel_id_fk" FOREIGN KEY ("personnel_id") REFERENCES "public"."personnel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "section_members" ADD CONSTRAINT "section_members_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "section_members" ADD CONSTRAINT "section_members_section_id_personnel_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."personnel_sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personnel_project_idx" ON "personnel" USING btree ("organisation_id","project_id");--> statement-breakpoint
CREATE INDEX "personnel_sections_idx" ON "personnel_sections" USING btree ("organisation_id","personnel_id");--> statement-breakpoint
CREATE INDEX "section_members_idx" ON "section_members" USING btree ("organisation_id","section_id");