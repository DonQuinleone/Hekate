CREATE TYPE "public"."upload_status" AS ENUM('open', 'completing', 'completed', 'aborted');--> statement-breakpoint
CREATE TABLE "upload_parts" (
	"organisation_id" uuid NOT NULL,
	"upload_id" uuid NOT NULL,
	"chunk" integer NOT NULL,
	"tag" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upload_parts_upload_id_chunk_pk" PRIMARY KEY("upload_id","chunk")
);
--> statement-breakpoint
CREATE TABLE "uploads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"folder_id" uuid,
	"created_by" text,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"status" "upload_status" DEFAULT 'open' NOT NULL,
	"blob_id" uuid NOT NULL,
	"backend" text NOT NULL,
	"key" text NOT NULL,
	"backend_upload_id" text NOT NULL,
	"wrapped_key" text NOT NULL,
	"key_version" integer NOT NULL,
	"nonce_prefix" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "blobs" ALTER COLUMN "sha256" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "upload_parts" ADD CONSTRAINT "upload_parts_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_parts" ADD CONSTRAINT "upload_parts_upload_id_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."uploads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "uploads_org_idx" ON "uploads" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "uploads_open_expiry_idx" ON "uploads" USING btree ("status","expires_at");