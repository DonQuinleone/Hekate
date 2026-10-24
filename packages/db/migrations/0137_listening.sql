CREATE TABLE "listening_room_people" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listening_rooms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"leader_id" text NOT NULL,
	"file_id" uuid,
	"playing" boolean DEFAULT false NOT NULL,
	"position" double precision DEFAULT 0 NOT NULL,
	"rate" double precision DEFAULT 1 NOT NULL,
	"state_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "listening_room_people" ADD CONSTRAINT "listening_room_people_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listening_room_people" ADD CONSTRAINT "listening_room_people_room_id_listening_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."listening_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listening_room_people" ADD CONSTRAINT "listening_room_people_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listening_rooms" ADD CONSTRAINT "listening_rooms_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listening_rooms" ADD CONSTRAINT "listening_rooms_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listening_rooms" ADD CONSTRAINT "listening_rooms_leader_id_users_id_fk" FOREIGN KEY ("leader_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listening_rooms" ADD CONSTRAINT "listening_rooms_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "listening_room_people_org_idx" ON "listening_room_people" USING btree ("organisation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "listening_room_people_idx" ON "listening_room_people" USING btree ("room_id","user_id");--> statement-breakpoint
CREATE INDEX "listening_rooms_org_idx" ON "listening_rooms" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "listening_rooms_project_idx" ON "listening_rooms" USING btree ("organisation_id","project_id");--> statement-breakpoint
CREATE INDEX "listening_rooms_leader_idx" ON "listening_rooms" USING btree ("leader_id");