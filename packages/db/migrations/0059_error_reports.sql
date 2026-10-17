CREATE TABLE "error_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"reference" text NOT NULL,
	"source" text NOT NULL,
	"location" text NOT NULL,
	"message" text NOT NULL,
	"stack" text,
	"status" integer,
	"request_id" text,
	"job_id" text,
	"context" jsonb,
	"organisation_id" uuid,
	"user_id" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "error_reports_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
ALTER TABLE "error_reports" ADD CONSTRAINT "error_reports_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "error_reports" ADD CONSTRAINT "error_reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "error_reports_occurred_idx" ON "error_reports" USING btree ("occurred_at");