ALTER TABLE "comments" ADD COLUMN "mentions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "todo" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "todo_done_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "todo_done_by_id" text;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_todo_done_by_id_users_id_fk" FOREIGN KEY ("todo_done_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;