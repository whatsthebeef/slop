-- The deploy queue: when each deploy began running (start timeouts count from it), and the queue's
-- invariant (at most one running and one waiting deploy per environment) as unique indexes backing
-- the per-environment lock. Duplicates from before the lock are resolved first: the newest stays.
UPDATE "deploys" d SET "state" = 'failed', "finished_at" = now(), "error" = 'Superseded by a newer running deploy (migration 0011)'
  WHERE d."state" = 'running' AND EXISTS (SELECT 1 FROM "deploys" o WHERE o."board_id" = d."board_id" AND o."environment" = d."environment"
    AND o."state" = 'running' AND (o."requested_at", o."id") > (d."requested_at", d."id"));
--> statement-breakpoint
UPDATE "deploys" d SET "state" = 'replaced', "finished_at" = now()
  WHERE d."state" = 'waiting' AND EXISTS (SELECT 1 FROM "deploys" o WHERE o."board_id" = d."board_id" AND o."environment" = d."environment"
    AND o."state" = 'waiting' AND (o."requested_at", o."id") > (d."requested_at", d."id"));
--> statement-breakpoint
ALTER TABLE "deploys" ADD COLUMN "running_since" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "deploys_one_running_idx" ON "deploys" USING btree ("board_id","environment") WHERE "deploys"."state" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "deploys_one_waiting_idx" ON "deploys" USING btree ("board_id","environment") WHERE "deploys"."state" = 'waiting';