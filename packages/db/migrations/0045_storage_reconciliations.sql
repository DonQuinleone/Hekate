CREATE TABLE "storage_reconciliations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope_organisation_id" uuid,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"removing" boolean NOT NULL
);
--> statement-breakpoint
CREATE INDEX "storage_reconciliations_started_idx" ON "storage_reconciliations" USING btree ("started_at");