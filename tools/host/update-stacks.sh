#!/bin/sh
# Updates Docker Compose stacks to the newest published images of their tags.
#
#   update-stacks.sh <stack folder> [<stack folder> ...]
#
# For each folder, in the order given, it downloads any newer image for the
# tag that folder's .env selects with APP_VERSION, then recreates only the
# containers whose image changed. Containers already up to date keep running.
# A stack that fails is reported and the others still update. Afterwards it
# removes images that no container uses.
#
# docs/guides/self-hosting.md runs it from a systemd timer, so a merge to main
# reaches the server a few minutes after its image is published.

set -u

if [ "$#" -eq 0 ]; then
  echo "Usage: $0 <stack folder> [<stack folder> ...]" >&2
  exit 2
fi

failed=0
for folder in "$@"; do
  echo "Updating the stack in $folder"
  if ! (cd "$folder" && docker compose pull --quiet && docker compose up -d); then
    echo "Could not update the stack in $folder" >&2
    failed=1
  fi
done

docker image prune --force >/dev/null || echo "Could not remove unused images" >&2
exit "$failed"
