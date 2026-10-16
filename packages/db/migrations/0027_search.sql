CREATE INDEX "comments_search_idx" ON "comments" USING gin (to_tsvector('simple', coalesce("body", '')));--> statement-breakpoint
CREATE INDEX "files_search_idx" ON "files" USING gin (to_tsvector('simple', coalesce("name", '')));--> statement-breakpoint
CREATE INDEX "projects_search_idx" ON "projects" USING gin (to_tsvector('simple', coalesce("name", '')));--> statement-breakpoint
CREATE INDEX "reviews_search_idx" ON "reviews" USING gin (to_tsvector('simple', coalesce("title", '') || ' ' || coalesce("message", '')));--> statement-breakpoint
CREATE INDEX "tracks_search_idx" ON "tracks" USING gin (to_tsvector('simple', coalesce("name", '')));