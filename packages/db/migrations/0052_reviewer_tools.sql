ALTER TABLE "review_reviewers" ALTER COLUMN "permissions" SET DEFAULT '{"comment":true,"decide":true,"comments":"all","tools":["spectrogram","meters","loops","qa","score"],"download":"none","history":false,"items":null,"maxPlays":null,"startsAt":null,"expiresAt":null}'::jsonb;--> statement-breakpoint
-- QA had been the meters' to give (#55): a reviewer who had the meters keeps the QA view.
UPDATE "review_reviewers"
  SET "permissions" = jsonb_set("permissions", '{tools}', ("permissions"->'tools') || '["qa"]'::jsonb)
  WHERE "permissions"->'tools' ? 'meters' AND NOT ("permissions"->'tools' ? 'qa');
