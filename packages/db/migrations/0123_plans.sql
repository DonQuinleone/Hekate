CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"price_amount" integer,
	"currency" text DEFAULT 'GBP' NOT NULL,
	"interval" text,
	"storage_quota" bigint,
	"member_limit" integer,
	"project_limit" integer,
	"features" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"severities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"retired_at" timestamp with time zone,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "workspace_plans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"trial_ends_at" timestamp with time zone,
	"renews_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "project_limit" integer;--> statement-breakpoint
ALTER TABLE "workspace_plans" ADD CONSTRAINT "workspace_plans_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_plans" ADD CONSTRAINT "workspace_plans_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_plans_organisation_idx" ON "workspace_plans" USING btree ("organisation_id");