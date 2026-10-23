ALTER TYPE "public"."audit_action" ADD VALUE 'organisation.channel_add' BEFORE 'project.archive';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'organisation.channel_change' BEFORE 'project.archive';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'organisation.channel_remove' BEFORE 'project.archive';--> statement-breakpoint
CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"target" text NOT NULL,
	"config_sealed" text NOT NULL,
	"key_version" integer NOT NULL,
	"events" text[] DEFAULT '{}' NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"paused_until" timestamp with time zone,
	"last_delivered_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_until" timestamp with time zone,
	"last_result" text,
	"delivered_at" timestamp with time zone,
	"replay_of" uuid,
	"replayed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_deliveries" ADD CONSTRAINT "event_deliveries_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_deliveries" ADD CONSTRAINT "event_deliveries_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_deliveries" ADD CONSTRAINT "event_deliveries_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_deliveries" ADD CONSTRAINT "event_deliveries_replayed_by_users_id_fk" FOREIGN KEY ("replayed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channels_organisation_idx" ON "channels" USING btree ("organisation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_deliveries_once_idx" ON "event_deliveries" USING btree ("channel_id","event_id") WHERE "event_deliveries"."replay_of" is null;--> statement-breakpoint
CREATE INDEX "event_deliveries_due_idx" ON "event_deliveries" USING btree ("next_attempt_at") WHERE "event_deliveries"."status" in ('pending', 'sending');--> statement-breakpoint
CREATE INDEX "event_deliveries_channel_idx" ON "event_deliveries" USING btree ("organisation_id","channel_id","created_at");--> statement-breakpoint
CREATE INDEX "event_deliveries_created_idx" ON "event_deliveries" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "events_waiting_idx" ON "events" USING btree ("created_at") WHERE "events"."dispatched_at" is null;--> statement-breakpoint
CREATE INDEX "events_organisation_idx" ON "events" USING btree ("organisation_id","created_at");