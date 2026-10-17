CREATE TABLE "instance_flags" (
	"key" text PRIMARY KEY NOT NULL,
	"on" boolean DEFAULT false NOT NULL,
	"until" timestamp with time zone,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "instance_flags" ADD CONSTRAINT "instance_flags_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;