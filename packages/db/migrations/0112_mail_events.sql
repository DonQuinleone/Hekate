CREATE TYPE "public"."mail_result" AS ENUM('sent', 'failed', 'logged');--> statement-breakpoint
CREATE TABLE "mail_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recipient" text NOT NULL,
	"subject" text NOT NULL,
	"result" "mail_result" NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE INDEX "mail_events_occurred_idx" ON "mail_events" USING btree ("occurred_at");