CREATE TABLE "billing_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"gateway" text NOT NULL,
	"customer_id" text NOT NULL,
	"subscription_id" text,
	"subscription_event_at" timestamp with time zone,
	"past_due_since" timestamp with time zone,
	"dunning_stage" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gateway_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gateway" text NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"organisation_id" uuid,
	"summary" text,
	"amount" integer,
	"currency" text,
	"result" text,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"taken_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"source" text NOT NULL,
	"gateway_id" text,
	"number" text,
	"status" text NOT NULL,
	"currency" text NOT NULL,
	"amount_due" integer NOT NULL,
	"amount_paid" integer DEFAULT 0 NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"issued_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_events" ADD CONSTRAINT "gateway_events_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_accounts_organisation_idx" ON "billing_accounts" USING btree ("organisation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_accounts_customer_idx" ON "billing_accounts" USING btree ("gateway","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_events_event_idx" ON "gateway_events" USING btree ("gateway","event_id");--> statement-breakpoint
CREATE INDEX "gateway_events_received_idx" ON "gateway_events" USING btree ("received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_gateway_idx" ON "invoices" USING btree ("source","gateway_id");--> statement-breakpoint
CREATE INDEX "invoices_organisation_idx" ON "invoices" USING btree ("organisation_id","issued_at");