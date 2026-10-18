ALTER TABLE "takes" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "takes" ADD CONSTRAINT "takes_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "takes_session_idx" ON "takes" USING btree ("organisation_id","session_id");