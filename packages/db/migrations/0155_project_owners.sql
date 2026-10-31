CREATE TABLE "project_owners" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"since" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_owners" ADD CONSTRAINT "project_owners_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_owners" ADD CONSTRAINT "project_owners_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_owners" ADD CONSTRAINT "project_owners_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_owners_user_idx" ON "project_owners" USING btree ("organisation_id","project_id","user_id");--> statement-breakpoint
CREATE INDEX "project_owners_user_lookup_idx" ON "project_owners" USING btree ("user_id");--> statement-breakpoint
-- Every project has an owner from the start (decision 285): its creator, the member whose role
-- was given in the same transaction that made the project, while they are still a member; else
-- its earliest member still there; else, for a project nobody holds a role in, the earliest
-- owner of its workspace.
INSERT INTO "project_owners" ("id", "organisation_id", "project_id", "user_id", "since")
SELECT
	encode(set_bit(set_bit(overlay(uuid_send(gen_random_uuid()) placing substring(int8send((extract(epoch from o."since") * 1000)::bigint) from 3) from 1 for 6), 52, 1), 53, 1), 'hex')::uuid,
	o."organisation_id",
	o."project_id",
	o."user_id",
	o."since"
FROM (
	SELECT DISTINCT ON (p."id")
		p."organisation_id",
		p."id" AS "project_id",
		c."user_id",
		CASE WHEN c."rank" = 2 THEN p."created_at" ELSE c."at" END AS "since"
	FROM "projects" p
	JOIN LATERAL (
		SELECT pm."user_id", pm."created_at" AS "at", 0 AS "rank"
		FROM "project_members" pm
		WHERE pm."organisation_id" = p."organisation_id" AND pm."project_id" = p."id"
			AND pm."created_at" = p."created_at"
		UNION ALL
		SELECT pm."user_id", pm."created_at", 1
		FROM "project_members" pm
		WHERE pm."organisation_id" = p."organisation_id" AND pm."project_id" = p."id"
		UNION ALL
		SELECT m."user_id", m."created_at", 2
		FROM "members" m
		WHERE m."organisation_id" = p."organisation_id" AND m."role" = 'owner'
	) c ON true
	ORDER BY p."id", c."rank", c."at", c."user_id"
) o;
