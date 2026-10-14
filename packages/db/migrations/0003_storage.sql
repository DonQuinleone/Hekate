CREATE TABLE "blobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"backend" text NOT NULL,
	"key" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"content_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "blob_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "storage_backend" text;--> statement-breakpoint
ALTER TABLE "blobs" ADD CONSTRAINT "blobs_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blobs_org_idx" ON "blobs" USING btree ("organisation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "blobs_backend_key_unique" ON "blobs" USING btree ("backend","key");--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_blob_id_blobs_id_fk" FOREIGN KEY ("blob_id") REFERENCES "public"."blobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "files_blob_idx" ON "files" USING btree ("blob_id");--> statement-breakpoint
ALTER TABLE "files" DROP COLUMN "storage_key";--> statement-breakpoint
ALTER TABLE "files" DROP COLUMN "wrapped_key";