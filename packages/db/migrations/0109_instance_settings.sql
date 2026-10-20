CREATE TABLE "instance_settings" (
	"id" text PRIMARY KEY DEFAULT 'instance' NOT NULL,
	"settings" jsonb NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instance_settings_one" CHECK ("instance_settings"."id" = 'instance')
);
--> statement-breakpoint
ALTER TABLE "instance_settings" ADD CONSTRAINT "instance_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;