ALTER TABLE "project_roles" ALTER COLUMN "tools" SET DEFAULT '{qa,meters,spectrogram,score,compare,loops,normalise}'::text[];--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "normalisation" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
-- Roles that listen (they have compare) may normalise too, as new roles do; normalisation stays off until a project chooses it.
UPDATE "project_roles" SET "tools" = array_append("tools", 'normalise') WHERE 'compare' = ANY("tools") AND NOT 'normalise' = ANY("tools");
