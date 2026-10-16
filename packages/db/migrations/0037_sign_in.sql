ALTER TYPE "public"."audit_action" ADD VALUE 'account.lockout' BEFORE 'organisation.rename';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'account.password_reset' BEFORE 'organisation.rename';--> statement-breakpoint
CREATE TABLE "sign_in_attempts" (
	"key" text PRIMARY KEY NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"last_failure_at" timestamp with time zone,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
