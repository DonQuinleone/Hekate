CREATE TABLE "file_pages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"page" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"blob_id" uuid NOT NULL,
	"thumb_blob_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "page_count" integer;--> statement-breakpoint
ALTER TABLE "file_pages" ADD CONSTRAINT "file_pages_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_pages" ADD CONSTRAINT "file_pages_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_pages" ADD CONSTRAINT "file_pages_blob_id_blobs_id_fk" FOREIGN KEY ("blob_id") REFERENCES "public"."blobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_pages" ADD CONSTRAINT "file_pages_thumb_blob_id_blobs_id_fk" FOREIGN KEY ("thumb_blob_id") REFERENCES "public"."blobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "file_pages_file_page_idx" ON "file_pages" USING btree ("organisation_id","file_id","page");