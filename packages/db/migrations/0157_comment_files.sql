ALTER TYPE "public"."audit_action" ADD VALUE 'comment.files_link' BEFORE 'file.captions_add';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'comment.files_unlink' BEFORE 'file.captions_add';--> statement-breakpoint
CREATE TABLE "comment_files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"comment_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"linked_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "comment_files" ADD CONSTRAINT "comment_files_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_files" ADD CONSTRAINT "comment_files_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_files" ADD CONSTRAINT "comment_files_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_files" ADD CONSTRAINT "comment_files_linked_by_id_users_id_fk" FOREIGN KEY ("linked_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "comment_files_pair_idx" ON "comment_files" USING btree ("comment_id","file_id");--> statement-breakpoint
CREATE INDEX "comment_files_file_idx" ON "comment_files" USING btree ("organisation_id","file_id");