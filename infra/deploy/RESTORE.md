# Restoring production's Postgres from a nightly dump

Generic steps; the tested run-through with real names and timings is in the board's knowledge base. Moving the laptop's
data to production the first time is a different procedure: [CUTOVER.md](CUTOVER.md).

Dumps are `pg_dump -Fc` files at `s3://slop-<stage>-backups-<account>/postgres/YYYY/MM/DD/slop-<timestamp>.dump`, kept 30 days.
The data disk is also snapshotted weekly (the newest four kept) by a Data Lifecycle Manager policy.

1. Open a shell on the instance: `aws ssm start-session --target <InstanceId>`; `sudo -i`.
2. Pick a dump and fetch it: `aws s3 ls --recursive s3://<bucket>/postgres/ | tail`, then
   `aws s3 cp s3://<bucket>/postgres/.../slop-<timestamp>.dump /var/lib/slop/restore.dump`.
3. Restore into a fresh database next to the live one (nothing running is touched):
   `docker exec slop-postgres-1 createdb -U slop slop_restore`, then
   `docker exec -i slop-postgres-1 pg_restore -U slop -d slop_restore --no-owner < /var/lib/slop/restore.dump`.
4. Check it: compare exact row counts with the live `slop` database. `infra/deploy/cutover-remote.sh` (copy it to the
   instance, e.g. through the backups bucket) prints them: `bash cutover-remote.sh counts slop_restore` and
   `bash cutover-remote.sh counts slop`. (`pg_stat_user_tables.n_live_tup` is only an estimate.)
5. To make it the live database, hold the deploy lock so a push to main can't restart the app halfway:
   `exec 9>/opt/slop/.deploy.lock; if flock -w 300 9; then docker stop slop-app-1; else echo "deploy lock busy"; fi`, which
   stops the app only once it holds the lock (on "deploy lock busy", let the deploy finish and run it again). Stop it with
   `docker stop`, not `docker compose`: there is no `.env` in `/opt/slop`, so compose can't read the file without the image
   and password `remote-deploy.sh` passes it.
   From the `postgres` database (`docker exec -it slop-postgres-1 psql -U slop -d postgres`), end any remaining connections
   (`select pg_terminate_backend(pid) from pg_stat_activity where datname in ('slop', 'slop_restore')`), then rename both in
   one transaction, so a failed second rename leaves `slop` as it was:
   `begin; alter database slop rename to slop_old; alter database slop_restore rename to slop; commit;`. Start the app
   (`docker start slop-app-1`, which keeps its image and settings), check `curl -fsS localhost:3000/auth/config`, and release
   the lock (`exec 9>&-`, or end the shell). Drop `slop_old` once satisfied. Remove `/var/lib/slop/restore.dump`.
   (`cutover-remote.sh swap` does the same steps with a rollback; it is written for the cutover's `slop_restore` and counts file.)
6. Losing the instance: attach the newest snapshot's volume (or the retained data disk) to a new instance as its data disk;
   the setup script mounts an existing filesystem as it is.
