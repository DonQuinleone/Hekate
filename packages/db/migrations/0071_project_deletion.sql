ALTER TYPE "public"."audit_action" ADD VALUE 'project.deletion_request';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'project.deletion_confirm';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'project.deletion_cancel';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'project.delete';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'deletion_requested' BEFORE 'assigned';--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "deletion_requested_by" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "deletion_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "delete_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_deletion_requested_by_users_id_fk" FOREIGN KEY ("deletion_requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;