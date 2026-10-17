CREATE TABLE "delivery_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"label" text NOT NULL,
	"spec" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "delivery_profile" text;--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "delivery_profile" text;--> statement-breakpoint
ALTER TABLE "delivery_profiles" ADD CONSTRAINT "delivery_profiles_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_profiles_label_idx" ON "delivery_profiles" USING btree ("organisation_id",lower("label"));