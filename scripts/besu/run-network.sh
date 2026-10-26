#!/usr/bin/env bash
# Runs all four validators in the foreground until interrupted. Logs go to <workdir>/node<i>.log.
#   BESU=... scripts/besu/run-network.sh <workdir>
HERE=$(cd "$(dirname "$0")" && pwd)
WD=$1
for i in 1 2 3 4; do
  "$HERE/start-node.sh" "$WD" "$i" > "$WD/node$i.log" 2>&1 &
  echo $! > "$WD/node$i.pid"
  sleep 4
done
wait
