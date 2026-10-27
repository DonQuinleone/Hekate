CREATE INDEX "access_events_guest_idx" ON "access_events" USING btree ("organisation_id","guest_id","id");--> statement-breakpoint
CREATE INDEX "files_size_idx" ON "files" USING btree ("organisation_id","byte_size");--> statement-breakpoint
CREATE INDEX "files_duration_idx" ON "files" USING btree ("organisation_id",(("media_info"->>'duration')::double precision));--> statement-breakpoint
CREATE INDEX "files_frame_rate_idx" ON "files" USING btree ("organisation_id",(("media_info"->'video'->>'fps')::double precision));