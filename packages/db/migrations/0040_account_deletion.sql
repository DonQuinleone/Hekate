ALTER TYPE "public"."audit_action" ADD VALUE 'account.deleted' BEFORE 'organisation.rename';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
-- Deleting an account leaves its trail in the access log, with its label (a name and address)
-- replaced. That one change is allowed, to rows of that account, in a transaction that names it:
--   set local hekate.audit_forget = '<user id>';
-- Every other update is still refused, and deletes still need an explicit purge.
CREATE OR REPLACE FUNCTION "access_events_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	kept "access_events";
BEGIN
	IF TG_OP = 'UPDATE' THEN
		IF OLD.user_id IS NOT NULL
			AND OLD.user_id = coalesce(current_setting('hekate.audit_forget', true), '')
			AND NEW.actor_label = 'A former member' THEN
			kept := NEW;
			kept.actor_label := OLD.actor_label;
			IF kept IS NOT DISTINCT FROM OLD THEN
				RETURN NEW;
			END IF;
		END IF;
		RAISE EXCEPTION 'The access log is append-only: rows cannot be changed'
			USING ERRCODE = 'insufficient_privilege';
	END IF;
	IF coalesce(current_setting('hekate.audit_purge', true), '') <> 'on' THEN
		RAISE EXCEPTION 'The access log is append-only: deleting needs an explicit purge'
			USING ERRCODE = 'insufficient_privilege';
	END IF;
	RETURN OLD;
END;
$$;
--> statement-breakpoint
-- An entry written for an account already deleted is labelled as a former member's, whatever
-- the writer thought the name was: a request in flight while the account is deleted cannot put
-- the name back. The deletion locks the account's row first; this waits on that lock, so it
-- sees the deletion once it has committed.
CREATE OR REPLACE FUNCTION "access_events_former_member"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	gone timestamptz;
BEGIN
	IF NEW.user_id IS NOT NULL THEN
		SELECT "deleted_at" INTO gone FROM "users" WHERE "id" = NEW.user_id FOR SHARE;
		IF gone IS NOT NULL THEN
			NEW.actor_label := 'A former member';
		END IF;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "access_events_former_member" BEFORE INSERT ON "access_events"
	FOR EACH ROW EXECUTE FUNCTION "access_events_former_member"();
