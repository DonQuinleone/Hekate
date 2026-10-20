CREATE TABLE "health_samples" (
	"id" uuid PRIMARY KEY NOT NULL,
	"replica" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"requests" integer NOT NULL,
	"errors" integer NOT NULL,
	"p95_seconds" double precision,
	"jobs_waiting" integer NOT NULL,
	"lanes" integer NOT NULL,
	"lanes_busy" integer NOT NULL,
	"upload_bytes" bigint NOT NULL,
	"cpu" double precision NOT NULL,
	"cores" integer NOT NULL,
	"memory_used" bigint NOT NULL,
	"memory_total" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "health_samples_minute" ON "health_samples" USING btree ("replica","at");--> statement-breakpoint
CREATE INDEX "health_samples_at" ON "health_samples" USING btree ("at");