CREATE TYPE "public"."task_priority" AS ENUM('low', 'normal', 'high');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('pending', 'in_progress', 'needs_approval', 'done');--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'task';--> statement-breakpoint
CREATE TABLE "task_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"actor_id" text,
	"actor_name" text,
	"kind" text NOT NULL,
	"detail" jsonb,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"notes" text,
	"status" "task_status" DEFAULT 'pending' NOT NULL,
	"priority" "task_priority" DEFAULT 'normal' NOT NULL,
	"assignee_id" text,
	"due_on" date,
	"track_id" uuid,
	"file_id" uuid,
	"comment_id" uuid,
	"run_id" uuid,
	"node_id" text,
	"created_by_id" text,
	"done_at" timestamp with time zone,
	"done_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "comments" DROP CONSTRAINT "comments_todo_done_by_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "tasks_numbered" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_done_by_id_users_id_fk" FOREIGN KEY ("done_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_events_org_idx" ON "task_events" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "task_events_task_idx" ON "task_events" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "tasks_org_idx" ON "tasks" USING btree ("organisation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_number_idx" ON "tasks" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "tasks_assignee_idx" ON "tasks" USING btree ("organisation_id","assignee_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_comment_idx" ON "tasks" USING btree ("comment_id");--> statement-breakpoint
CREATE INDEX "tasks_run_idx" ON "tasks" USING btree ("run_id");--> statement-breakpoint
-- A thread made a task before tasks existed (#133) becomes a task of its project (#140): done where it was done, given to whoever the thread was for, numbered in the order the threads were written. The comment no longer holds it (decision 124). Ids are UUIDv7, made here from when each thread was written.
INSERT INTO "tasks" ("id", "organisation_id", "project_id", "number", "title", "status", "assignee_id", "file_id", "comment_id", "done_at", "done_by_id", "created_at", "updated_at")
SELECT
	encode(set_bit(set_bit(overlay(uuid_send(gen_random_uuid()) placing substring(int8send((extract(epoch from c."created_at") * 1000)::bigint) from 3) from 1 for 6), 52, 1), 53, 1), 'hex')::uuid,
	c."organisation_id",
	f."project_id",
	row_number() OVER (PARTITION BY f."project_id" ORDER BY c."created_at", c."id"),
	coalesce(nullif(left(regexp_replace(btrim(split_part(btrim(c."body", E' \t\r\n'), E'\n', 1)), '\s+', ' ', 'g'), 120), ''), 'Comment on ' || f."name"),
	CASE WHEN c."todo_done_at" IS NOT NULL THEN 'done'::"task_status" ELSE 'pending'::"task_status" END,
	c."assignee_id",
	c."file_id",
	c."id",
	c."todo_done_at",
	c."todo_done_by_id",
	c."created_at",
	now()
FROM "comments" c
JOIN "files" f ON f."id" = c."file_id" AND f."organisation_id" = c."organisation_id"
WHERE c."todo" AND c."parent_id" IS NULL;--> statement-breakpoint
INSERT INTO "task_events" ("id", "organisation_id", "task_id", "kind", "created_at")
SELECT
	encode(set_bit(set_bit(overlay(uuid_send(gen_random_uuid()) placing substring(int8send((extract(epoch from t."created_at") * 1000)::bigint) from 3) from 1 for 6), 52, 1), 53, 1), 'hex')::uuid,
	t."organisation_id",
	t."id",
	'from_comment',
	t."created_at"
FROM "tasks" t
WHERE t."comment_id" IS NOT NULL;--> statement-breakpoint
UPDATE "projects" p SET "tasks_numbered" = n."count"
FROM (SELECT "project_id", max("number") AS "count" FROM "tasks" GROUP BY "project_id") n
WHERE n."project_id" = p."id";--> statement-breakpoint
ALTER TABLE "comments" DROP COLUMN "todo";--> statement-breakpoint
ALTER TABLE "comments" DROP COLUMN "todo_done_at";--> statement-breakpoint
ALTER TABLE "comments" DROP COLUMN "todo_done_by_id";