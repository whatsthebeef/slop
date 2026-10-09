#!/bin/bash
# EC2 user data for the slop host (Amazon Linux 2023, arm64): Docker, the Compose plugin and the data disk.
# It runs once, as root, when the instance first boots. The app itself arrives with the first deploy
# (CodeBuild, through SSM); nothing here needs the network beyond the OS repositories and GitHub releases.
set -euxo pipefail

dnf install -y docker
systemctl enable --now docker

# Compose plugin (not in the AL2023 repositories).
COMPOSE_VERSION=v2.29.7
mkdir -p /usr/local/lib/docker/cli-plugins
curl -fsSL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-aarch64" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# The data disk: the one whole disk that is not the root's. Format it only when it has no filesystem yet,
# so a replaced instance keeps the database it finds on the volume.
ROOT_DISK="/dev/$(lsblk -no PKNAME "$(findmnt -n -o SOURCE /)")"
DATA_DISK=""
for disk in $(lsblk -dpno NAME,TYPE | awk '$2=="disk" {print $1}'); do
  if [ "$disk" != "$ROOT_DISK" ]; then DATA_DISK="$disk"; fi
done
if [ -n "$DATA_DISK" ]; then
  if ! blkid "$DATA_DISK" >/dev/null 2>&1; then mkfs -t xfs "$DATA_DISK"; fi
  mkdir -p /var/lib/slop
  UUID="$(blkid -s UUID -o value "$DATA_DISK")"
  grep -q "$UUID" /etc/fstab || echo "UUID=$UUID /var/lib/slop xfs defaults,nofail 0 2" >> /etc/fstab
  mount -a
fi
mkdir -p /var/lib/slop/postgres /opt/slop
