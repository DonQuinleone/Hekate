ALTER TABLE "reviews" ADD COLUMN "workflow_run_id" uuid;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "workflow_node_id" text;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reviews_workflow_idx" ON "reviews" USING btree ("workflow_run_id");