CREATE TABLE "billing_credits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"source" text NOT NULL,
	"gateway_id" text,
	"amount" integer NOT NULL,
	"currency" text NOT NULL,
	"reason" text NOT NULL,
	"invoice_id" uuid,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "credit" integer;--> statement-breakpoint
ALTER TABLE "billing_credits" ADD CONSTRAINT "billing_credits_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_credits" ADD CONSTRAINT "billing_credits_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_credits" ADD CONSTRAINT "billing_credits_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_credits_organisation_idx" ON "billing_credits" USING btree ("organisation_id","invoice_id");