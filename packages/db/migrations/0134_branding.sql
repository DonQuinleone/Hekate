ALTER TYPE "public"."audit_action" ADD VALUE 'organisation.branding' BEFORE 'organisation.directory';--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "branding" jsonb;