ALTER TABLE "invoices" ADD COLUMN "pdf_url" text;--> statement-breakpoint
ALTER TABLE "workspace_plans" ADD COLUMN "cancels_at" timestamp with time zone;