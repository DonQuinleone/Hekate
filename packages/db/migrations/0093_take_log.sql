ALTER TABLE "sessions" ADD COLUMN "numbering" text DEFAULT 'per-track' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "slot_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "slot_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "takes" ADD COLUMN "lifecycle" text DEFAULT 'recorded' NOT NULL;--> statement-breakpoint
ALTER TABLE "takes" ADD COLUMN "false_starts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "takes" ADD COLUMN "timecode_in" text;--> statement-breakpoint
ALTER TABLE "takes" ADD COLUMN "timecode_out" text;--> statement-breakpoint
ALTER TABLE "takes" ADD COLUMN "wall_in" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "takes" ADD COLUMN "wall_out" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "takes" ADD COLUMN "page_to" integer;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_numbering" CHECK ("sessions"."numbering" in ('continuous', 'per-track', 'recorder'));--> statement-breakpoint
ALTER TABLE "takes" ADD CONSTRAINT "takes_lifecycle" CHECK ("takes"."lifecycle" in ('idle', 'armed', 'recording', 'recorded', 'aborted'));--> statement-breakpoint
ALTER TABLE "takes" ADD CONSTRAINT "takes_false_starts" CHECK ("takes"."false_starts" >= 0);