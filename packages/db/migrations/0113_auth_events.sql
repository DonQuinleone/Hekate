CREATE TYPE "public"."auth_method" AS ENUM('password', 'passkey', 'second_factor', 'directory', 'sso', 'guest_link', 'guest_code');--> statement-breakpoint
CREATE TYPE "public"."auth_result" AS ENUM('signed_in', 'refused', 'locked');--> statement-breakpoint
CREATE TABLE "auth_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"method" "auth_method" NOT NULL,
	"result" "auth_result" NOT NULL,
	"reason" text,
	"account" text NOT NULL,
	"user_id" text,
	"organisation_id" uuid,
	"ip_address" text,
	"user_agent" text
);
--> statement-breakpoint
ALTER TABLE "auth_events" ADD CONSTRAINT "auth_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_events" ADD CONSTRAINT "auth_events_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_events_occurred_idx" ON "auth_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "auth_events_org_idx" ON "auth_events" USING btree ("organisation_id","id");