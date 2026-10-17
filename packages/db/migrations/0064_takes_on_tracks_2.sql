ALTER TABLE "takes" ADD COLUMN "track_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "takes" ADD COLUMN "rating" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "takes" ADD COLUMN "starred" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "takes" ADD COLUMN "page" integer;--> statement-breakpoint
ALTER TABLE "takes" ADD COLUMN "bar_from" integer;--> statement-breakpoint
ALTER TABLE "takes" ADD COLUMN "bar_to" integer;--> statement-breakpoint
ALTER TABLE "takes" ADD COLUMN "in_point" double precision;--> statement-breakpoint
ALTER TABLE "takes" ADD COLUMN "out_point" double precision;--> statement-breakpoint
ALTER TABLE "takes" ADD CONSTRAINT "takes_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "takes_track_number_idx" ON "takes" USING btree ("track_id","number");--> statement-breakpoint
CREATE INDEX "takes_coverage_idx" ON "takes" USING btree ("organisation_id","track_id","bar_from","bar_to");--> statement-breakpoint
ALTER TABLE "takes" ADD CONSTRAINT "takes_rating_range" CHECK ("takes"."rating" between 0 and 5);--> statement-breakpoint
ALTER TABLE "takes" ADD CONSTRAINT "takes_bars_order" CHECK ("takes"."bar_from" is null or "takes"."bar_to" is null or "takes"."bar_from" <= "takes"."bar_to");