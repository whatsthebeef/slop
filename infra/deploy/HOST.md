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
   - the data volume attachment appears as a new `AWS::EC2::VolumeAttachment` only.
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
