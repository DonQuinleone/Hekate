-- hekate: contracts
-- Release 2 of the rename (decision 295, #484): `variations` goes, with the trigger that kept
-- `variants` in step with it (migration 0149). A release that still reads `variations` cannot
-- run against the database once this has run, so it is the newest migration an older release
-- must know (decision 198), and it drops a table, so an upgrade applies it only with
-- MIGRATE_ALLOW_DESTRUCTIVE=true.
--
-- Nothing is lost: the backfill in 0149 and the trigger since carried every row across under
-- the same id, but a row that somehow did not follow is copied now, before the drop. Where its
-- file is already a variant it is that variant already, and is left; where its version already
-- has a primary variant it comes across as a second one, not primary. No table ever had a
-- `variation_id` column (what points at a variant points at its file or its version), so there
-- is nothing else to carry.
INSERT INTO "variants" ("id", "organisation_id", "version_id", "file_id", "name", "is_primary", "position", "subtitled", "graded", "created_at", "updated_at")
SELECT v."id", v."organisation_id", v."version_id", v."file_id", v."name",
	v."is_primary" AND NOT EXISTS (
		SELECT 1 FROM "variants" p WHERE p."version_id" = v."version_id" AND p."is_primary"
	),
	v."position", v."subtitled", v."graded", v."created_at", v."updated_at"
FROM "variations" v
WHERE NOT EXISTS (SELECT 1 FROM "variants" w WHERE w."id" = v."id" OR w."file_id" = v."file_id")
ON CONFLICT DO NOTHING;
--> statement-breakpoint
DROP TRIGGER "variations_follow_into_variants" ON "variations";--> statement-breakpoint
DROP FUNCTION "variations_follow_into_variants"();--> statement-breakpoint
DROP TABLE "variations" CASCADE;
