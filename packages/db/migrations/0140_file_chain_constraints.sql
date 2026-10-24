-- Before the constraints (#427): a version naming a file that no longer exists starts its own
-- chain, and where two files name the same one (the routes never allow it), the earlier keeps it.
UPDATE "files" SET "previous_file_id" = NULL WHERE "previous_file_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "files" AS "previous" WHERE "previous"."id" = "files"."previous_file_id");--> statement-breakpoint
UPDATE "files" SET "previous_file_id" = NULL WHERE "id" IN (SELECT "id" FROM (SELECT "id", row_number() OVER (PARTITION BY "previous_file_id" ORDER BY "created_at", "id") AS "n" FROM "files" WHERE "previous_file_id" IS NOT NULL) AS "ranked" WHERE "n" > 1);--> statement-breakpoint
DROP INDEX "files_previous_idx";--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_previous_file_id_files_id_fk" FOREIGN KEY ("previous_file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "files_previous_unique" ON "files" USING btree ("previous_file_id");