CREATE TABLE "alignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"from_file_id" uuid NOT NULL,
	"to_file_id" uuid NOT NULL,
	"status" "stream_status" DEFAULT 'pending' NOT NULL,
	"points" jsonb,
	"quality" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "comment_carries" ADD COLUMN "anchor_placed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "alignments" ADD CONSTRAINT "alignments_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alignments" ADD CONSTRAINT "alignments_from_file_id_files_id_fk" FOREIGN KEY ("from_file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alignments" ADD CONSTRAINT "alignments_to_file_id_files_id_fk" FOREIGN KEY ("to_file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alignments_org_idx" ON "alignments" USING btree ("organisation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "alignments_pair_idx" ON "alignments" USING btree ("from_file_id","to_file_id");--> statement-breakpoint
CREATE INDEX "alignments_to_idx" ON "alignments" USING btree ("to_file_id");