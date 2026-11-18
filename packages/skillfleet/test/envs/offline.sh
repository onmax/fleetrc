#!/bin/sh
# Network sources, then no network at all: init online against a GitHub source and a skills index,
# then run sync, sync --offline, doctor, status and a fresh init --offline in a `--network none`
# container over the same HOME.
#
#   sh test/envs/offline.sh <tarball>
set -u
here="$(cd "$(dirname "$0")" && pwd)"
tgz="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
vol="sf-u2-offline-home"
docker volume rm -f "$vol" >/dev/null 2>&1
docker volume create "$vol" >/dev/null
docker run --rm -u root -v "$vol:/home/node" sf-u2-alpine22 chown node:node /home/node

run() { # run <network> <script>
  docker run --rm --network "$1" -v "$vol:/home/node" -v "$tgz:/pkg/skillfleet.tgz:ro" \
    -e DO_NOT_TRACK=1 -e npm_config_update_notifier=false sf-u2-alpine22 sh -c "$2"
}

echo "--- online: init"
run bridge '
set -e
mkdir -p ~/.claude ~/.codex ~/m
cat >~/m/skills.json <<EOF
{ "agents": "all", "sources": [
  { "id": "nuxt", "git": "onmax/nuxt-skills", "include": ["nuxt"] },
  { "id": "drop", "index": "https://drop.vitehub.dev" }
] }
EOF
npx -y --package /pkg/skillfleet.tgz -- skillfleet init ~/m/skills.json --no-hooks
npx -y --package /pkg/skillfleet.tgz -- skillfleet self-install
ls ~/.claude/skills'

SF=/home/node/.local/state/skillfleet/bin/skillfleet
echo "--- offline: sync without --offline (expect a clear per-source error, links kept)"
run none "$SF sync; echo \"exit \$?\"; ls ~/.claude/skills"
echo "--- offline: sync --offline (expect exit 0)"
run none "$SF sync --offline; echo \"exit \$?\""
echo "--- offline: doctor"
run none "$SF doctor; echo \"exit \$?\""
echo "--- offline: status"
run none "$SF status | head -n 8; echo \"exit \$?\""
echo "--- offline: add a GitHub source"
run none "$SF add onmax/skills-nope; echo \"exit \$?\""
echo "--- offline: a second machine, init --offline with nothing cached"
run none 'mkdir -p /tmp/h2/.claude && HOME=/tmp/h2 npx --offline -y --package /pkg/skillfleet.tgz -- skillfleet init /home/node/m/skills.json --offline --no-hooks; echo "exit $?"'
echo "--- offline: init --offline again on the cached machine"
run none "$SF init --offline --no-hooks; echo \"exit \$?\""
docker volume rm -f "$vol" >/dev/null
