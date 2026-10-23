ALTER TYPE "public"."audit_action" ADD VALUE 'api_token.create' BEFORE 'account.deleted';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'api_token.change' BEFORE 'account.deleted';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'api_token.revoke' BEFORE 'account.deleted';--> statement-breakpoint
CREATE TABLE "api_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"token_id" uuid,
	"token_name" text NOT NULL,
	"token_kind" text NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"status" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"ip_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"hint" text NOT NULL,
	"token_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by" text,
	"revoked_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "api_requests" ADD CONSTRAINT "api_requests_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_requests" ADD CONSTRAINT "api_requests_token_id_api_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."api_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_requests_org_idx" ON "api_requests" USING btree ("organisation_id","id");--> statement-breakpoint
CREATE INDEX "api_requests_token_idx" ON "api_requests" USING btree ("token_id");--> statement-breakpoint
CREATE INDEX "api_tokens_organisation_idx" ON "api_tokens" USING btree ("organisation_id","kind");--> statement-breakpoint
CREATE INDEX "api_tokens_user_idx" ON "api_tokens" USING btree ("user_id");