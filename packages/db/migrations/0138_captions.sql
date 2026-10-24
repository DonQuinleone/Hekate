ALTER TYPE "public"."audit_action" ADD VALUE 'file.captions_update' BEFORE 'comment.export';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'file.captions_export' BEFORE 'comment.export';--> statement-breakpoint
ALTER TABLE "caption_tracks" ADD COLUMN "language" text;--> statement-breakpoint
ALTER TABLE "caption_tracks" ADD COLUMN "kind" text DEFAULT 'subtitles' NOT NULL;