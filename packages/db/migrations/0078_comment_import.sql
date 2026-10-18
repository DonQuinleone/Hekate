ALTER TYPE "public"."audit_action" ADD VALUE 'comment.import' BEFORE 'account.lockout';--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "imported_from" text;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "imported_by_id" text;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_imported_by_id_users_id_fk" FOREIGN KEY ("imported_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;