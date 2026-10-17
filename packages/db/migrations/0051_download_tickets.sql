CREATE TABLE "download_tickets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"token_hash" text NOT NULL,
	"session_id" text NOT NULL,
	"user_id" text,
	"guest_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "review_reviewers" ALTER COLUMN "permissions" SET DEFAULT '{"comment":true,"decide":true,"comments":"all","tools":["spectrogram","meters","loops"],"download":"none","startsAt":null,"expiresAt":null}'::jsonb;--> statement-breakpoint
ALTER TABLE "download_tickets" ADD CONSTRAINT "download_tickets_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "download_tickets" ADD CONSTRAINT "download_tickets_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "download_tickets" ADD CONSTRAINT "download_tickets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "download_tickets" ADD CONSTRAINT "download_tickets_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "download_tickets_token_idx" ON "download_tickets" USING btree ("token_hash");