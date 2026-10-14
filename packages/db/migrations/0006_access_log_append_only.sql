-- The access log is append-only (docs/security.md).
-- Updates are always refused. Deletes are refused unless the transaction sets
-- `hekate.audit_purge` to 'on', which only retention and organisation removal do:
--   begin; set local hekate.audit_purge = 'on'; delete ...; commit;
CREATE FUNCTION "access_events_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'UPDATE' THEN
		RAISE EXCEPTION 'The access log is append-only: rows cannot be changed'
			USING ERRCODE = 'insufficient_privilege';
	END IF;
	IF coalesce(current_setting('hekate.audit_purge', true), '') <> 'on' THEN
		RAISE EXCEPTION 'The access log is append-only: deleting needs an explicit purge'
			USING ERRCODE = 'insufficient_privilege';
	END IF;
	RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "access_events_no_update" BEFORE UPDATE ON "access_events"
	FOR EACH ROW EXECUTE FUNCTION "access_events_append_only"();--> statement-breakpoint
CREATE TRIGGER "access_events_no_delete" BEFORE DELETE ON "access_events"
	FOR EACH ROW EXECUTE FUNCTION "access_events_append_only"();--> statement-breakpoint
-- TRUNCATE skips row triggers, so refuse it separately.
CREATE TRIGGER "access_events_no_truncate" BEFORE TRUNCATE ON "access_events"
	FOR EACH STATEMENT EXECUTE FUNCTION "access_events_append_only"();
