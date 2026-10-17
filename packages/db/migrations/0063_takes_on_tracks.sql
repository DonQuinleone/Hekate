-- Takes move from sessions to tracks (#21). No version of Hekate could create a take, so any row
-- here was made by hand; it cannot be placed on a track, and is removed so the move can be made.
DELETE FROM "takes";--> statement-breakpoint
CREATE TABLE "session_tracks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"track_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "takes" DROP CONSTRAINT "takes_session_id_sessions_id_fk";
--> statement-breakpoint
DROP INDEX "takes_session_number_idx";--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "venue" text;--> statement-breakpoint
ALTER TABLE "session_tracks" ADD CONSTRAINT "session_tracks_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_tracks" ADD CONSTRAINT "session_tracks_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_tracks" ADD CONSTRAINT "session_tracks_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_tracks_pair_idx" ON "session_tracks" USING btree ("session_id","track_id");--> statement-breakpoint
CREATE INDEX "session_tracks_track_idx" ON "session_tracks" USING btree ("organisation_id","track_id");--> statement-breakpoint
ALTER TABLE "takes" DROP COLUMN "session_id";