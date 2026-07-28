#!/bin/sh
# Altscan indexer entrypoint.
#
# Resolves START_BLOCK=tip into a concrete recent block number before starting.
#
# Why this exists: the indexer's built-in defaults are chain.defaultStartBlock —
# 38,000,000 for BNB (tens of millions of blocks behind the head) and 0 for ETH
# (genesis). Either one makes a fresh self-hosted install appear broken: it indexes
# for days without ever reaching current data. Starting near the tip gives a usable
# explorer in minutes.
#
# START_BLOCK is only consulted when the database is empty; once blocks exist the
# indexer resumes from its own maximum, so this is safe to run on every boot.

set -e

resolve_tip() {
  rpc_url="$1"
  node -e '
    const url = process.argv[1];
    const lookback = Number(process.env.START_BLOCK_LOOKBACK || "1000");
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
    })
      .then((r) => r.json())
      .then((j) => {
        if (!j || typeof j.result !== "string") throw new Error("bad RPC response: " + JSON.stringify(j));
        const tip = parseInt(j.result, 16);
        if (!Number.isFinite(tip) || tip <= 0) throw new Error("bad tip: " + j.result);
        process.stdout.write(String(Math.max(0, tip - lookback)));
      })
      .catch((e) => {
        process.stderr.write("[entrypoint] tip lookup failed: " + e.message + "\n");
        process.exit(1);
      });
  ' "$rpc_url"
}

if [ "${START_BLOCK}" = "tip" ]; then
  case "${CHAIN:-bnb}" in
    eth) RPC="${ETH_RPC_URL}" ;;
    *)   RPC="${BNB_RPC_URL}" ;;
  esac

  if [ -z "${RPC}" ]; then
    echo "[entrypoint] START_BLOCK=tip but no RPC URL set for CHAIN=${CHAIN:-bnb}" >&2
    exit 1
  fi

  echo "[entrypoint] START_BLOCK=tip — querying ${CHAIN:-bnb} head via RPC..."
  if RESOLVED=$(resolve_tip "${RPC}"); then
    START_BLOCK="${RESOLVED}"
    export START_BLOCK
    echo "[entrypoint] START_BLOCK resolved to ${START_BLOCK} (head minus ${START_BLOCK_LOOKBACK:-1000})"
  else
    echo "[entrypoint] could not resolve chain head — check your RPC URL" >&2
    exit 1
  fi
fi

exec "$@"
