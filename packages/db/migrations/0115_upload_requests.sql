ALTER TYPE "public"."audit_action" ADD VALUE 'upload_request.create' BEFORE 'file.delete';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'upload_request.close' BEFORE 'file.delete';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'upload_request.password_failed' BEFORE 'file.delete';--> statement-breakpoint
ALTER TYPE "public"."audit_actor" ADD VALUE 'visitor' BEFORE 'system';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'upload_arrived';--> statement-breakpoint
CREATE TABLE "upload_request_files" (
	"file_id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"sender" text NOT NULL,
	"arrived_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upload_request_uploads" (
	"upload_id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"sender" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upload_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"folder_id" uuid,
	"created_by" text,
	"name" text NOT NULL,
	"wanted" text DEFAULT '' NOT NULL,
	"file_limit" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token_hash" text NOT NULL,
	"password_hash" text,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "upload_request_files" ADD CONSTRAINT "upload_request_files_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_request_files" ADD CONSTRAINT "upload_request_files_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_request_files" ADD CONSTRAINT "upload_request_files_request_id_upload_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."upload_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_request_uploads" ADD CONSTRAINT "upload_request_uploads_upload_id_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."uploads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_request_uploads" ADD CONSTRAINT "upload_request_uploads_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_request_uploads" ADD CONSTRAINT "upload_request_uploads_request_id_upload_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."upload_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_requests" ADD CONSTRAINT "upload_requests_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_requests" ADD CONSTRAINT "upload_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_requests" ADD CONSTRAINT "upload_requests_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_requests" ADD CONSTRAINT "upload_requests_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "upload_request_files_request_idx" ON "upload_request_files" USING btree ("organisation_id","request_id");--> statement-breakpoint
CREATE INDEX "upload_request_uploads_request_idx" ON "upload_request_uploads" USING btree ("organisation_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "upload_requests_token_idx" ON "upload_requests" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "upload_requests_project_idx" ON "upload_requests" USING btree ("organisation_id","project_id");