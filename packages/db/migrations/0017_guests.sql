ALTER TYPE "public"."audit_action" ADD VALUE 'guest.link';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'guest.sign_in';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'guest.revoke';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'guest.view';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'comment.create';--> statement-breakpoint
CREATE TABLE "guest_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"guest_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guest_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"guest_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"label" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "review_reviewers" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "guest_author_id" uuid;--> statement-breakpoint
ALTER TABLE "review_reviewers" ADD COLUMN "guest_id" uuid;--> statement-breakpoint
ALTER TABLE "guest_links" ADD CONSTRAINT "guest_links_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_links" ADD CONSTRAINT "guest_links_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_sessions" ADD CONSTRAINT "guest_sessions_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_sessions" ADD CONSTRAINT "guest_sessions_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guests" ADD CONSTRAINT "guests_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guests" ADD CONSTRAINT "guests_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "guest_links_token_idx" ON "guest_links" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "guest_sessions_token_idx" ON "guest_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "guests_email_idx" ON "guests" USING btree ("organisation_id","email");--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_guest_author_id_guests_id_fk" FOREIGN KEY ("guest_author_id") REFERENCES "public"."guests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_reviewers" ADD CONSTRAINT "review_reviewers_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "review_reviewers_guest_idx" ON "review_reviewers" USING btree ("organisation_id","review_id","guest_id");--> statement-breakpoint
CREATE INDEX "review_reviewers_guest_lookup_idx" ON "review_reviewers" USING btree ("guest_id");--> statement-breakpoint
ALTER TABLE "review_reviewers" ADD CONSTRAINT "review_reviewers_one_person" CHECK (("review_reviewers"."user_id" is null) <> ("review_reviewers"."guest_id" is null));