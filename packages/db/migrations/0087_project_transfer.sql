-- A project moving to another workspace (#240, decision 135) takes its review decisions with it.
-- They stay append-only: inside a transaction that sets
--   set local hekate.project_transfer = 'on';
-- a decision may change its workspace and nothing else, so its id, its decision, who made it
-- and when stay exactly as recorded. Every other update is still refused, flag or not, and a
-- delete still goes through only with its review or workspace.
CREATE OR REPLACE FUNCTION "review_decisions_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	kept "review_decisions";
BEGIN
	IF TG_OP = 'UPDATE' THEN
		IF coalesce(current_setting('hekate.project_transfer', true), '') = 'on' THEN
			kept := NEW;
			kept.organisation_id := OLD.organisation_id;
			IF kept IS NOT DISTINCT FROM OLD THEN
				RETURN NEW;
			END IF;
		END IF;
	ELSIF NOT EXISTS (SELECT 1 FROM "reviews" WHERE "id" = OLD."review_id")
		OR NOT EXISTS (SELECT 1 FROM "organisations" WHERE "id" = OLD."organisation_id") THEN
		RETURN OLD;
	END IF;
	RAISE EXCEPTION 'Review decisions are append-only: rows cannot be changed or removed'
		USING ERRCODE = 'insufficient_privilege';
END;
$$;
