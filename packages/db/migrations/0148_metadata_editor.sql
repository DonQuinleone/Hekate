ALTER TYPE "public"."audit_action" ADD VALUE 'file.metadata_edit';--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "metadata_corrections" jsonb;