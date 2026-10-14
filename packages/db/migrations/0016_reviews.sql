CREATE TYPE "public"."approval_rule" AS ENUM('all', 'any');--> statement-breakpoint
CREATE TYPE "public"."review_decision" AS ENUM('approved', 'changes_requested');--> statement-breakpoint
CREATE TYPE "public"."review_kind" AS ENUM('approval', 'feedback');--> statement-breakpoint
CREATE TYPE "public"."review_order" AS ENUM('parallel', 'sequence');--> statement-breakpoint
CREATE TYPE "public"."review_status" AS ENUM('open', 'completed', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'review.create';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'review.cancel';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'review.decision';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'review.submit';--> statement-breakpoint
CREATE TABLE "review_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"decision" "review_decision" NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"track_id" uuid,
	"version_id" uuid,
	"file_id" uuid,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_items_one_kind" CHECK (("review_items"."track_id" is not null and "review_items"."file_id" is null) or ("review_items"."track_id" is null and "review_items"."file_id" is not null and "review_items"."version_id" is null))
);
--> statement-breakpoint
CREATE TABLE "review_reviewers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"position" integer NOT NULL,
	"viewed_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "review_kind" NOT NULL,
	"title" text NOT NULL,
	"message" text,
	"due_at" timestamp with time zone,
	"order" "review_order" DEFAULT 'parallel' NOT NULL,
	"rule" "approval_rule",
	"status" "review_status" DEFAULT 'open' NOT NULL,
	"outcome" text,
	"created_by" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_reviewer_id_review_reviewers_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."review_reviewers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_version_id_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_reviewers" ADD CONSTRAINT "review_reviewers_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_reviewers" ADD CONSTRAINT "review_reviewers_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_reviewers" ADD CONSTRAINT "review_reviewers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_decisions_review_idx" ON "review_decisions" USING btree ("organisation_id","review_id","created_at");--> statement-breakpoint
CREATE INDEX "review_items_review_idx" ON "review_items" USING btree ("organisation_id","review_id");--> statement-breakpoint
CREATE UNIQUE INDEX "review_reviewers_user_idx" ON "review_reviewers" USING btree ("organisation_id","review_id","user_id");--> statement-breakpoint
CREATE INDEX "reviews_project_idx" ON "reviews" USING btree ("organisation_id","project_id","created_at");--> statement-breakpoint
-- Approval decisions are append-only (docs/domain.md): a later decision supersedes an
-- earlier one but never erases it. Rows leave only with their review or organisation.
-- A delete is refused while the review still exists, so the cascade from a deleted review
-- (or organisation) goes through but a decision cannot be removed on its own.
CREATE FUNCTION "review_decisions_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' AND (
		NOT EXISTS (SELECT 1 FROM "reviews" WHERE "id" = OLD."review_id")
		OR NOT EXISTS (SELECT 1 FROM "organisations" WHERE "id" = OLD."organisation_id")
	) THEN
		RETURN OLD;
	END IF;
	RAISE EXCEPTION 'Review decisions are append-only: rows cannot be changed or removed'
		USING ERRCODE = 'insufficient_privilege';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "review_decisions_no_update" BEFORE UPDATE OR DELETE ON "review_decisions"
	FOR EACH ROW EXECUTE FUNCTION "review_decisions_append_only"();
