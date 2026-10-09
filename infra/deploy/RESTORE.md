# Restoring production's Postgres from a nightly dump

Generic steps; the tested run-through with real names and timings is in the board's knowledge base.

Dumps are `pg_dump -Fc` files at `s3://slop-<stage>-backups-<account>/postgres/YYYY/MM/DD/slop-<timestamp>.dump`, kept 30 days.
The data disk is also snapshotted weekly (the newest four kept) by a Data Lifecycle Manager policy.

1. Open a shell on the instance: `aws ssm start-session --target <InstanceId>`; `sudo -i`.
2. Pick a dump and fetch it: `aws s3 ls --recursive s3://<bucket>/postgres/ | tail`, then
   `aws s3 cp s3://<bucket>/postgres/.../slop-<timestamp>.dump /var/lib/slop/restore.dump`.
3. Restore into a fresh database next to the live one (nothing running is touched):
   `docker exec slop-postgres-1 createdb -U slop slop_restore`, then
   `docker exec -i slop-postgres-1 pg_restore -U slop -d slop_restore --no-owner < /var/lib/slop/restore.dump`.
4. Check it: compare row counts (`select relname, n_live_tup from pg_stat_user_tables order by 1`) with the live `slop` database.
5. To make it the live database: stop the app (`docker compose -p slop stop app`), rename `slop` to `slop_old` and `slop_restore`
   to `slop` (`alter database ... rename to ...` from the `postgres` database), then start the app and check `/auth/config`.
   Drop `slop_old` once satisfied. Remove `/var/lib/slop/restore.dump`.
6. Losing the instance: attach the newest snapshot's volume (or the retained data disk) to a new instance as its data disk;
   the setup script mounts an existing filesystem as it is.
