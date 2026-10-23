CREATE TABLE "workspace_usage" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"month" date NOT NULL,
	"storage_bytes" bigint DEFAULT 0 NOT NULL,
	"storage_peak" bigint DEFAULT 0 NOT NULL,
	"members" integer DEFAULT 0 NOT NULL,
	"guests" integer DEFAULT 0 NOT NULL,
	"projects" integer DEFAULT 0 NOT NULL,
	"plays" integer DEFAULT 0 NOT NULL,
	"downloads" integer DEFAULT 0 NOT NULL,
	"counted_through" uuid,
	"measured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "storage_quota" bigint;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "member_limit" integer;--> statement-breakpoint
ALTER TABLE "workspace_usage" ADD CONSTRAINT "workspace_usage_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_usage_month_idx" ON "workspace_usage" USING btree ("organisation_id","month");