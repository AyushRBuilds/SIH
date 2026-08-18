#!/bin/bash
# ============================================================
# SIH 2026 Food Traceability — Fabric Network Bootstrap
# network-up.sh
#
# Run this from WSL Ubuntu in the fabric/network/ directory.
# Prerequisite: fabric-samples binaries must be in PATH or
# FABRIC_BIN_PATH must be set.
#
# Usage:
#   cd services/blockchain-service/fabric/network
#   chmod +x scripts/*.sh
#   ./scripts/network-up.sh
# ============================================================

set -e
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NETWORK_DIR="$(dirname "$SCRIPT_DIR")"

# Fabric binaries — use fabric-samples bin if available
FABRIC_BIN_PATH="${FABRIC_BIN_PATH:-$HOME/fabric-samples/bin}"
export PATH="$FABRIC_BIN_PATH:$PATH"
export FABRIC_CFG_PATH="$NETWORK_DIR"

echo "============================================================"
echo " SIH 2026 — Bringing up Five-Organization Fabric Network"
echo "============================================================"
echo " Network directory : $NETWORK_DIR"
echo " Fabric binaries   : $FABRIC_BIN_PATH"
echo ""

# Verify fabric binaries exist
for bin in cryptogen configtxgen; do
    if ! command -v $bin &>/dev/null; then
        echo "ERROR: '$bin' not found. Add fabric-samples/bin to PATH."
        echo "       Run: export FABRIC_BIN_PATH=~/fabric-samples/bin"
        exit 1
    fi
done

# ============================================================
# STEP 1: Generate crypto material for all 5 orgs
# ============================================================
echo "[1/5] Generating crypto material (cryptogen)..."
cd "$NETWORK_DIR"

if [ -d "organizations/peerOrganizations" ]; then
    echo "      Crypto material already exists. Skipping."
else
    cryptogen generate \
        --config="$NETWORK_DIR/crypto-config.yaml" \
        --output="$NETWORK_DIR/organizations"
    echo "      ✓ Crypto material generated in organizations/"
fi

# ============================================================
# STEP 2: Generate channel artifacts
# ============================================================
echo "[2/5] Generating channel artifacts (configtxgen)..."
mkdir -p "$NETWORK_DIR/channel-artifacts"

# Genesis block for the orderer (system channel disabled — using channel participation API)
if [ ! -f "$NETWORK_DIR/channel-artifacts/genesis.block" ]; then
    configtxgen \
        -profile SIHGenesis \
        -channelID system-channel \
        -outputBlock "$NETWORK_DIR/channel-artifacts/genesis.block"
    echo "      ✓ Genesis block generated"
else
    echo "      Genesis block already exists. Skipping."
fi

# Channel creation transaction
if [ ! -f "$NETWORK_DIR/channel-artifacts/tracechannel.tx" ]; then
    configtxgen \
        -profile TraceChannel \
        -outputCreateChannelTx "$NETWORK_DIR/channel-artifacts/tracechannel.tx" \
        -channelID tracechannel
    echo "      ✓ tracechannel.tx generated"
else
    echo "      tracechannel.tx already exists. Skipping."
fi

# Anchor peer updates for each org
declare -A ORGS=(
    ["RegulatoryDepartmentMSP"]="RegulatoryDepartment"
    ["ProducerMSP"]="Producer"
    ["ManufacturerMSP"]="Manufacturer"
    ["DelivererMSP"]="Deliverer"
    ["RetailerMSP"]="Retailer"
)

for MSP in "${!ORGS[@]}"; do
    PROFILE_ORG="${ORGS[$MSP]}"
    ANCHOR_TX="$NETWORK_DIR/channel-artifacts/${MSP}anchors.tx"
    if [ ! -f "$ANCHOR_TX" ]; then
        configtxgen \
            -profile TraceChannel \
            -outputAnchorPeersUpdate "$ANCHOR_TX" \
            -channelID tracechannel \
            -asOrg "${PROFILE_ORG}MSP"
        echo "      ✓ Anchor peer update: $MSP"
    fi
done

# ============================================================
# STEP 3: Create peer config directory
# ============================================================
echo "[3/5] Creating peer config..."
mkdir -p "$NETWORK_DIR/peercfg"
if [ ! -f "$NETWORK_DIR/peercfg/core.yaml" ]; then
    if [ -f "$HOME/fabric-samples/config/core.yaml" ]; then
        cp "$HOME/fabric-samples/config/core.yaml" "$NETWORK_DIR/peercfg/"
        echo "      ✓ core.yaml copied from fabric-samples"
    else
        echo "      WARNING: core.yaml not found. Peers may not start correctly."
        echo "               Copy it from: fabric-samples/config/core.yaml"
    fi
fi

# ============================================================
# STEP 4: Start Docker containers
# ============================================================
echo "[4/5] Starting Docker containers..."
cd "$NETWORK_DIR"
docker compose -f docker-compose-fabric.yml up -d --remove-orphans

echo "      Waiting 10s for peers and orderer to start..."
sleep 10

# Verify containers are running
echo "      Running containers:"
docker compose -f docker-compose-fabric.yml ps

# ============================================================
# STEP 5: Create channel and join all peers
# ============================================================
echo "[5/5] Creating tracechannel and joining peers..."
"$SCRIPT_DIR/create-channel.sh"

echo ""
echo "============================================================"
echo " ✓ Fabric network is UP"
echo " Channel : tracechannel"
echo " Orgs    : RegulatoryDepartmentMSP, ProducerMSP,"
echo "           ManufacturerMSP, DelivererMSP, RetailerMSP"
echo ""
echo " Next: Deploy chaincode"
echo "   ./scripts/deploy-chaincode.sh"
echo "============================================================"
