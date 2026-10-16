ALTER TYPE "public"."audit_action" ADD VALUE 'version.let_through' BEFORE 'guest.link';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'variation.replace' BEFORE 'guest.link';--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "check_true_peak" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "require_edl" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "versions" ADD COLUMN "edl_file_id" uuid;--> statement-breakpoint
ALTER TABLE "versions" ADD COLUMN "let_through_by" text;--> statement-breakpoint
ALTER TABLE "versions" ADD CONSTRAINT "versions_edl_file_id_files_id_fk" FOREIGN KEY ("edl_file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "versions" ADD CONSTRAINT "versions_let_through_by_users_id_fk" FOREIGN KEY ("let_through_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;