CREATE TABLE "spectrogram_variant_failures" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"analysis" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spectrogram_variants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"analysis" text NOT NULL,
	"channel" text NOT NULL,
	"fft_size" integer NOT NULL,
	"sample_rate" integer NOT NULL,
	"samples_per_column" integer NOT NULL,
	"column_count" integer NOT NULL,
	"band_count" integer NOT NULL,
	"blob_id" uuid NOT NULL,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spectrogram_variant_failures" ADD CONSTRAINT "spectrogram_variant_failures_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spectrogram_variant_failures" ADD CONSTRAINT "spectrogram_variant_failures_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spectrogram_variants" ADD CONSTRAINT "spectrogram_variants_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spectrogram_variants" ADD CONSTRAINT "spectrogram_variants_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spectrogram_variants" ADD CONSTRAINT "spectrogram_variants_blob_id_blobs_id_fk" FOREIGN KEY ("blob_id") REFERENCES "public"."blobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "spectrogram_variant_failures_file_idx" ON "spectrogram_variant_failures" USING btree ("organisation_id","file_id","analysis");--> statement-breakpoint
CREATE UNIQUE INDEX "spectrogram_variants_file_idx" ON "spectrogram_variants" USING btree ("organisation_id","file_id","analysis","channel");--> statement-breakpoint
CREATE INDEX "spectrogram_variants_used_idx" ON "spectrogram_variants" USING btree ("used_at");