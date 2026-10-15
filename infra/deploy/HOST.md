# The host stack: AMI, data volume and deploying safely

`slop-prod-host` must never replace the instance or give it an empty data disk. On 2026-10-13 a deploy resolved a newer
Amazon Linux 2023 AMI, CloudFormation replaced the instance, and the new instance got an empty data disk. Two rules
prevent that:

- **The AMI is pinned** with `-c hostAmiId=ami-...`. Prod refuses to synthesise without it.
- **The data disk is its own volume**, attached to `/dev/sdf` by an `AWS::EC2::VolumeAttachment`. Prod refuses to
  synthesise without `-c hostDataVolumeId=vol-...`, and the stack never creates production's volume.

## Deploying

1. Read both values from the running instance (`<id>` is the stack's `InstanceId` output):
   `aws ec2 describe-instances --instance-ids <id> --query 'Reservations[0].Instances[0].[ImageId,BlockDeviceMappings]'`.
   The AMI is `ImageId`; the data volume is the one on `/dev/sdf`.
2. `cdk diff slop-prod-host -c stage=prod -c hostAmiId=<ami> -c hostDataVolumeId=<vol> ...` (plus the usual contexts).
   Before deploying, check all of these:
   - `Host` (`AWS::EC2::Instance`) is **not** marked `[-/+]` or "replace";
   - no `AWS::EC2::Volume` is added;
   - the data volume attachment appears as a new `AWS::EC2::VolumeAttachment` only. That is safe only while the volume
     is **detached**: CloudFormation can't attach a volume that is already attached, so on a host whose volume was
     attached by hand the deploy fails with "already attached" and rolls back. `host-deploy.sh` detects this before
     `cdk diff` and stops; see "Handing over a volume attached by hand".
3. **The first deploy of this layout is itself a replacement.** CloudFormation treats a change to an instance's
   `BlockDeviceMappings` as a replacement, and this change removes `/dev/sdf` from them. So the first time, `cdk diff`
   will show `Host` replaced: don't deploy it as it is. Follow "Changing the AMI" below (snapshot, stop, detach the
   volume, deploy), with `-c hostAmiId` set to the AMI the instance runs now. Once the volume is its own resource, later
   deploys must show no replacement; if one does, **stop**, because something else changed (the AMI, subnet, instance
   type or security group). A changed `userData` stops and starts the instance in place (a short outage, no data loss).
4. If you can't take the outage, don't deploy the host stack from this layout yet; the other stacks are unaffected.
5. The weekly snapshot policy selects the instance by tag with `excludeBootVolume: true`, so it snapshots whatever
   volumes are attached at 04:00 UTC on Sundays. Check afterwards that a snapshot of the data volume appears
   (`aws ec2 describe-snapshots --filters Name=volume-id,Values=<vol>`).

## Handing over a volume attached by hand

The state: the data volume is attached to the instance at `/dev/sdf`, but `slop-<stage>-host` has no
`AWS::EC2::VolumeAttachment` (production's volume was re-attached by hand after the 2026-10-13 incident). The first
deploy would try to create the attachment and fail with `"vol-... is already attached to an instance"`.
`host-deploy.sh` checks for this before `cdk diff` and exits with status 3 and the steps, changing nothing.

The stack can only attach the volume while it is detached, and `host-deploy.sh` reads the volume from `/dev/sdf`, so
once it is detached pass it with `--data-volume <vol-id>` (prod refuses to run without one). The handover is a short
outage of the app. Either run it with `host-deploy.sh --hand-over-volume`, or by hand:

1. Snapshot the volume and wait for it to complete.
2. On the instance, hold `/opt/slop/.deploy.lock` (so no CodeBuild deploy starts), `docker stop slop-app-1`,
   `docker stop slop-postgres-1`, `sync`, `umount /var/lib/slop`.
3. `aws ec2 detach-volume --volume-id <vol>` and wait for `available`.
4. `host-deploy.sh --data-volume <vol>`: check the diff as above, then deploy. The stack attaches the volume.
5. Wait for `in-use`, then on the instance `mount -a`, start `slop-postgres-1` and then `slop-app-1`, release the lock and
   check `curl localhost:3000/auth/config`.

If the deploy fails or you stop, attach the volume again (`aws ec2 attach-volume --volume-id <vol> --instance-id <id>
--device /dev/sdf`), `mount -a` and start both containers. `--hand-over-volume` does all of it: it takes the snapshot,
detaches only after the diff is shown and you confirm (or `--yes`), and re-attaches and restarts if the deploy fails.
It changes paid infrastructure, so a person runs it, never an agent.

## Changing the AMI (a deliberate replacement)

A new AMI replaces the instance. CloudFormation creates the new instance before deleting the old one, and the data
volume is still attached to the old one, so the new attachment cannot be created. Do it in this order:

1. Take a snapshot of the data volume and check it completes.
2. Stop the app and Postgres on the old instance (see RESTORE.md, step 5), then stop the instance.
3. Detach the data volume: `aws ec2 detach-volume --volume-id <vol>`.
4. Deploy with the new `-c hostAmiId=<new ami>`. The new instance boots, waits up to 10 minutes for the volume, and
   `instance-setup.sh` mounts the existing filesystem (it only formats a disk that has no filesystem).
5. Let the CodeBuild deploy run, or re-run it: `remote-deploy.sh` refuses to start on an empty data disk.

Never deploy with a different `hostDataVolumeId` than the one holding production's data.

## Disk space and image pruning

Every deploy pulls a new image, so `remote-deploy.sh` removes old ones: after a successful deploy it keeps the release
now running and the one before it (for rollback) and removes the other images of the repository, dangling images and
build cache. Images used by a running container are never removed. Before pulling, it needs `MIN_FREE_MB` (default 4096)
free on `/var/lib/docker`; if short, it prunes first, and if still short it fails with
"instance disk full: N GB free, need M GB" without touching the running release.

Manual recovery after that failure: over SSM on the instance run `docker image prune -af` (the running containers'
images stay), or grow the root volume, then re-run the deploy project.
