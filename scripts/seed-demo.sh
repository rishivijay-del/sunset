#!/bin/sh
# Deploys the Sunset demo metadata (and, unless --no-data, 1,000 demo accounts) into one org.
# Usage: ./scripts/seed-demo.sh sunset-dev [--no-data]
set -e
ALIAS="${1:-sunset-dev}"
cd "$(dirname "$0")/../demo"
echo "Deploying demo metadata to $ALIAS ..."
sf project deploy start --source-dir force-app -o "$ALIAS" --wait 30
echo "Assigning the Sunset Demo Access permission set ..."
sf org assign permset --name Sunset_Demo_Access -o "$ALIAS" || true
if [ "$2" != "--no-data" ]; then
  echo "Loading 1,000 demo accounts ..."
  sf data import bulk --sobject Account --file data/accounts.csv -o "$ALIAS" --wait 15
fi
echo "Done. Current time in UTC (use for usage.ignoreWritesBefore):"
date -u +"%Y-%m-%dT%H:%M:%SZ"
