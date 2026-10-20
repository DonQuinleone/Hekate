ALTER TABLE "stage_items" ADD COLUMN "personnel_id" uuid;--> statement-breakpoint
ALTER TABLE "stage_items" ADD CONSTRAINT "stage_items_personnel_id_personnel_id_fk" FOREIGN KEY ("personnel_id") REFERENCES "public"."personnel"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stage_items_personnel_idx" ON "stage_items" USING btree ("personnel_id");