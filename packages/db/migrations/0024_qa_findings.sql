CREATE TABLE "qa_findings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"check" text NOT NULL,
	"severity" text NOT NULL,
	"summary" text NOT NULL,
	"channel" integer,
	"start" double precision,
	"end" double precision,
	"details" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "delivery_profile" text;--> statement-breakpoint
ALTER TABLE "qa_findings" ADD CONSTRAINT "qa_findings_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_findings" ADD CONSTRAINT "qa_findings_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "qa_findings_org_idx" ON "qa_findings" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "qa_findings_file_idx" ON "qa_findings" USING btree ("file_id");