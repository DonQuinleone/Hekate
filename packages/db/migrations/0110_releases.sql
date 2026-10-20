CREATE TABLE "release_checks" (
	"id" text PRIMARY KEY DEFAULT 'instance' NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"releases" jsonb NOT NULL,
	"failed" text,
	CONSTRAINT "release_checks_one" CHECK ("release_checks"."id" = 'instance')
);
--> statement-breakpoint
CREATE TABLE "versions_run" (
	"version" text PRIMARY KEY NOT NULL,
	"first_started_at" timestamp with time zone DEFAULT now() NOT NULL
);
