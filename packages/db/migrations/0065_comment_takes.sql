ALTER TYPE "public"."audit_action" ADD VALUE 'comment.takes_share' BEFORE 'comment.export';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'comment.takes_unshare' BEFORE 'comment.export';--> statement-breakpoint
CREATE TABLE "comment_takes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"comment_id" uuid NOT NULL,
	"take_id" uuid NOT NULL,
	"shared_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "comment_takes" ADD CONSTRAINT "comment_takes_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_takes" ADD CONSTRAINT "comment_takes_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_takes" ADD CONSTRAINT "comment_takes_take_id_takes_id_fk" FOREIGN KEY ("take_id") REFERENCES "public"."takes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_takes" ADD CONSTRAINT "comment_takes_shared_by_id_users_id_fk" FOREIGN KEY ("shared_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "comment_takes_pair_idx" ON "comment_takes" USING btree ("comment_id","take_id");--> statement-breakpoint
CREATE INDEX "comment_takes_take_idx" ON "comment_takes" USING btree ("organisation_id","take_id");