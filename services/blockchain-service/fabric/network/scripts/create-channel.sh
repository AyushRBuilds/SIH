#!/bin/bash
# ============================================================
# SIH 2026 — Create tracechannel and Join All Five Peers
# create-channel.sh
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NETWORK_DIR="$(dirname "$SCRIPT_DIR")"
FABRIC_BIN_PATH="${FABRIC_BIN_PATH:-$HOME/fabric-samples/bin}"

export PATH="$FABRIC_BIN_PATH:$PATH"
export FABRIC_CFG_PATH="$NETWORK_DIR/peercfg"

ORG_DIR="$NETWORK_DIR/organizations/peerOrganizations"
ORDERER_CA="$NETWORK_DIR/organizations/ordererOrganizations/example.com/tlsca/tlsca.example.com-cert.pem"
ORDERER_ADDR="localhost:7050"
ORDERER_ADMIN_TLS="$NETWORK_DIR/organizations/ordererOrganizations/example.com/orderers/orderer.example.com/tls/server.crt"
CHANNEL_ID="tracechannel"

echo "[create-channel] Creating $CHANNEL_ID..."

# ============================================================
# Helper function to set peer environment for a given org
# ============================================================
set_peer_env() {
    local MSP=$1
    local DOMAIN=$2
    local PORT=$3

    export CORE_PEER_LOCALMSPID="$MSP"
    export CORE_PEER_TLS_ENABLED="true"
    export CORE_PEER_TLS_ROOTCERT_FILE="$ORG_DIR/$DOMAIN/tlsca/tlsca.${DOMAIN}-cert.pem"
    export CORE_PEER_MSPCONFIGPATH="$ORG_DIR/$DOMAIN/users/Admin@${DOMAIN}/msp"
    export CORE_PEER_ADDRESS="localhost:$PORT"
}

# ============================================================
# Create channel using the orderer admin (channel participation API)
# For Fabric 2.5 osnadmin approach
# ============================================================

# Use peer channel create (traditional approach, works with genesis block method)
# First, create channel from ProducerMSP (any member can create)
set_peer_env "ProducerMSP" "producer.example.com" "8051"

echo "[create-channel] Creating channel from ProducerMSP..."
peer channel create \
    -o "$ORDERER_ADDR" \
    -c "$CHANNEL_ID" \
    -f "$NETWORK_DIR/channel-artifacts/${CHANNEL_ID}.tx" \
    --outputBlock "$NETWORK_DIR/channel-artifacts/${CHANNEL_ID}.block" \
    --tls \
    --cafile "$ORDERER_CA" \
    --ordererTLSHostnameOverride "orderer.example.com" \
    2>&1 | tail -5

echo "      ✓ Channel $CHANNEL_ID created"

# ============================================================
# Join all five peers to the channel
# ============================================================
declare -a PEERS=(
    "RegulatoryDepartmentMSP:regulatorydepartment.example.com:7051"
    "ProducerMSP:producer.example.com:8051"
    "ManufacturerMSP:manufacturer.example.com:9051"
    "DelivererMSP:deliverer.example.com:10051"
    "RetailerMSP:retailer.example.com:11051"
)

for PEER_INFO in "${PEERS[@]}"; do
    IFS=":" read -r MSP DOMAIN PORT <<< "$PEER_INFO"
    set_peer_env "$MSP" "$DOMAIN" "$PORT"

    echo "[create-channel] Joining $MSP ($DOMAIN:$PORT)..."
    peer channel join \
        -b "$NETWORK_DIR/channel-artifacts/${CHANNEL_ID}.block" \
        2>&1 | tail -3
    echo "      ✓ $MSP joined $CHANNEL_ID"
done

# ============================================================
# Update anchor peers for each org
# ============================================================
echo "[create-channel] Setting anchor peers..."
for PEER_INFO in "${PEERS[@]}"; do
    IFS=":" read -r MSP DOMAIN PORT <<< "$PEER_INFO"
    set_peer_env "$MSP" "$DOMAIN" "$PORT"

    ANCHOR_TX="$NETWORK_DIR/channel-artifacts/${MSP}anchors.tx"
    if [ -f "$ANCHOR_TX" ]; then
        peer channel update \
            -o "$ORDERER_ADDR" \
            -c "$CHANNEL_ID" \
            -f "$ANCHOR_TX" \
            --tls \
            --cafile "$ORDERER_CA" \
            --ordererTLSHostnameOverride "orderer.example.com" \
            2>&1 | tail -3
        echo "      ✓ Anchor peer set: $MSP"
    fi
done

echo "[create-channel] ✓ All peers joined tracechannel"
