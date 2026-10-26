#!/usr/bin/env bash
# Starts validator <i> (1..4) of the network created by setup-qbft.sh.
#   BESU=... scripts/besu/start-node.sh <workdir> <i>
set -euo pipefail
BESU=${BESU:-besu}
WD=$1; I=$2
P2P=$((30302 + I)); RPC=$((8544 + I))
export BESU_OPTS="${BESU_OPTS:--Xmx700m}"
exec "$BESU" --data-path="$WD/node$I/data" --genesis-file="$WD/genesis.json" --static-nodes-file="$WD/static-nodes.json" \
  --p2p-host=127.0.0.1 --p2p-port=$P2P --rpc-http-enabled --rpc-http-host=127.0.0.1 --rpc-http-port=$RPC \
  --rpc-http-api=ETH,NET,QBFT,WEB3,TXPOOL,DEBUG --host-allowlist="*" --min-gas-price=0 \
  --tx-pool-max-future-by-sender=2000 --discovery-enabled=false --metrics-enabled=false \
  --logging=WARN
