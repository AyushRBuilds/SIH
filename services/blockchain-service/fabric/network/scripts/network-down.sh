#!/bin/bash
# ============================================================
# SIH 2026 — Tear Down Fabric Network
# network-down.sh
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NETWORK_DIR="$(dirname "$SCRIPT_DIR")"

echo "============================================================"
echo " SIH 2026 — Tearing down Fabric Network"
echo "============================================================"

cd "$NETWORK_DIR"

docker compose -f docker-compose-fabric.yml down --volumes --remove-orphans

echo " Docker containers stopped and volumes removed."
echo ""
echo " To also remove crypto material and channel artifacts:"
echo "   rm -rf organizations/ channel-artifacts/"
echo "============================================================"
