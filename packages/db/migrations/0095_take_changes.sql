CREATE TABLE "take_changes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"take_id" uuid NOT NULL,
	"field" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"changed_by_id" text,
	"written_at" timestamp with time zone NOT NULL,
	"overwrote" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "take_changes" ADD CONSTRAINT "take_changes_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "take_changes" ADD CONSTRAINT "take_changes_take_id_takes_id_fk" FOREIGN KEY ("take_id") REFERENCES "public"."takes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "take_changes" ADD CONSTRAINT "take_changes_changed_by_id_users_id_fk" FOREIGN KEY ("changed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "take_changes_take_idx" ON "take_changes" USING btree ("organisation_id","take_id","created_at");