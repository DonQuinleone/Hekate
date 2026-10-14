CREATE TYPE "public"."carry_status" AS ENUM('open', 'fixed', 'not_fixed', 'wont_fix');--> statement-breakpoint
CREATE TABLE "comment_carries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"comment_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"anchor" jsonb,
	"visible" boolean DEFAULT true NOT NULL,
	"status" "carry_status" DEFAULT 'open' NOT NULL,
	"status_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "carried_comments_shown" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "comment_carries" ADD CONSTRAINT "comment_carries_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_carries" ADD CONSTRAINT "comment_carries_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_carries" ADD CONSTRAINT "comment_carries_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_carries" ADD CONSTRAINT "comment_carries_status_by_id_users_id_fk" FOREIGN KEY ("status_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comment_carries_org_idx" ON "comment_carries" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "comment_carries_file_idx" ON "comment_carries" USING btree ("file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "comment_carries_thread_file_idx" ON "comment_carries" USING btree ("comment_id","file_id");