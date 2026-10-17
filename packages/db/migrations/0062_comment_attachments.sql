ALTER TYPE "public"."audit_action" ADD VALUE 'comment.attachment_add' BEFORE 'comment.export';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'comment.attachment_download' BEFORE 'comment.export';--> statement-breakpoint
CREATE TABLE "comment_attachments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"comment_id" uuid NOT NULL,
	"blob_id" uuid NOT NULL,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "download_tickets" ADD COLUMN "attachment_id" uuid;--> statement-breakpoint
ALTER TABLE "comment_attachments" ADD CONSTRAINT "comment_attachments_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_attachments" ADD CONSTRAINT "comment_attachments_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_attachments" ADD CONSTRAINT "comment_attachments_blob_id_blobs_id_fk" FOREIGN KEY ("blob_id") REFERENCES "public"."blobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comment_attachments_comment_idx" ON "comment_attachments" USING btree ("organisation_id","comment_id");--> statement-breakpoint
ALTER TABLE "download_tickets" ADD CONSTRAINT "download_tickets_attachment_id_comment_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."comment_attachments"("id") ON DELETE cascade ON UPDATE no action;