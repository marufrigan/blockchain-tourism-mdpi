#!/usr/bin/env bash
# Builds a 4-validator Hyperledger Besu QBFT network on one host (2 s blocks, 30 M gas, zero base fee).
#   BESU=/path/to/besu/bin/besu scripts/besu/setup-qbft.sh <workdir>
# Prefunded test accounts are derived from keccak256("pctf-besu-<i>") (see besu-qbft.js).
set -euo pipefail
BESU=${BESU:-besu}
WD=${1:-./besu-net}
HERE=$(cd "$(dirname "$0")" && pwd)
rm -rf "$WD" && mkdir -p "$WD"
node "$HERE/alloc.js" "$HERE/qbftConfigFile.json" > "$WD/qbftConfigFile.json"
"$BESU" operator generate-blockchain-config --config-file="$WD/qbftConfigFile.json" --to="$WD/networkFiles" --private-key-file-name=key >/dev/null
cp "$WD/networkFiles/genesis.json" "$WD/genesis.json"
i=1
for k in "$WD"/networkFiles/keys/*; do
  mkdir -p "$WD/node$i/data"
  cp "$k/key" "$k/key.pub" "$WD/node$i/data/"
  i=$((i+1))
done
# static peering on localhost (discovery is disabled)
{
  echo "["
  for j in 1 2 3 4; do
    PUB=$(sed 's/^0x//' "$WD/node$j/data/key.pub")
    SEP=","; [ "$j" = "4" ] && SEP=""
    echo "  \"enode://$PUB@127.0.0.1:$((30302 + j))\"$SEP"
  done
  echo "]"
} > "$WD/static-nodes.json"
echo "network files in $WD"
