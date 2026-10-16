ALTER TYPE "public"."audit_action" ADD VALUE 'review.remind' BEFORE 'guest.link';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'review.due' BEFORE 'guest.link';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'review.reviewer_add' BEFORE 'guest.link';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'review.reviewer_remove' BEFORE 'guest.link';--> statement-breakpoint
CREATE TABLE "review_item_opens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "review_reviewers" ADD COLUMN "feedback_note" text;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "grant" jsonb;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "cancelled_by" text;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "review_item_opens" ADD CONSTRAINT "review_item_opens_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_item_opens" ADD CONSTRAINT "review_item_opens_reviewer_id_review_reviewers_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."review_reviewers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_item_opens" ADD CONSTRAINT "review_item_opens_item_id_review_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."review_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "review_item_opens_idx" ON "review_item_opens" USING btree ("organisation_id","reviewer_id","item_id");--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;