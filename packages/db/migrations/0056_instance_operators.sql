CREATE TABLE "instance_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"target" text,
	"details" jsonb,
	"ip_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instance_operators" (
	"user_id" text PRIMARY KEY NOT NULL,
	"added_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "instance_events" ADD CONSTRAINT "instance_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instance_operators" ADD CONSTRAINT "instance_operators_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instance_operators" ADD CONSTRAINT "instance_operators_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "instance_events_created_idx" ON "instance_events" USING btree ("created_at");--> statement-breakpoint
-- An instance installed before operators existed: its first owner, the one setup made, becomes the first operator, so somebody can always reach the instance side.
INSERT INTO "instance_operators" ("user_id")
SELECT "user_id" FROM "members" WHERE "role" = 'owner' ORDER BY "created_at" LIMIT 1
ON CONFLICT DO NOTHING;
