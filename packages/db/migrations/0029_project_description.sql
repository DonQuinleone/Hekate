ALTER TYPE "public"."audit_action" ADD VALUE 'project.archive';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'project.unarchive';--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "description" text;