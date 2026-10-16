ALTER TYPE "public"."audit_action" ADD VALUE 'account.sso_sign_in' BEFORE 'organisation.rename';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'organisation.sso' BEFORE 'project.archive';--> statement-breakpoint
CREATE TABLE "sso_providers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"issuer" text NOT NULL,
	"domain" text DEFAULT '' NOT NULL,
	"oidc_config" text,
	"saml_config" text,
	"user_id" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"protocol" text DEFAULT 'oidc' NOT NULL,
	"client_id" text DEFAULT '' NOT NULL,
	"entry_point" text DEFAULT '' NOT NULL,
	"certificate" text DEFAULT '' NOT NULL,
	"groups_claim" text DEFAULT 'groups' NOT NULL,
	"roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enforce" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_providers_provider_id_unique" UNIQUE("provider_id")
);
--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD COLUMN "sso_provider_id" text;--> statement-breakpoint
ALTER TABLE "sso_providers" ADD CONSTRAINT "sso_providers_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_providers" ADD CONSTRAINT "sso_providers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sso_providers_organisation_idx" ON "sso_providers" USING btree ("organisation_id");