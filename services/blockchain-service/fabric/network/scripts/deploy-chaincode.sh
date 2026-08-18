#!/bin/bash
# ============================================================
# SIH 2026 — Install, Approve, and Commit Chaincode
# deploy-chaincode.sh
#
# Chaincode: traceability (TypeScript/Node.js)
# Channel:   tracechannel
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NETWORK_DIR="$(dirname "$SCRIPT_DIR")"
FABRIC_BIN_PATH="${FABRIC_BIN_PATH:-$HOME/fabric-samples/bin}"
REPO_ROOT="$(dirname "$(dirname "$(dirname "$NETWORK_DIR")")")"

export PATH="$FABRIC_BIN_PATH:$PATH"
export FABRIC_CFG_PATH="$NETWORK_DIR/peercfg"

ORG_DIR="$NETWORK_DIR/organizations/peerOrganizations"
ORDERER_CA="$NETWORK_DIR/organizations/ordererOrganizations/example.com/tlsca/tlsca.example.com-cert.pem"
ORDERER_ADDR="localhost:7050"
CHANNEL_ID="tracechannel"

CHAINCODE_NAME="traceability"
CHAINCODE_VERSION="1.0"
CHAINCODE_SEQUENCE="1"
CHAINCODE_SRC="$REPO_ROOT/services/blockchain-service/fabric/chaincode"
CHAINCODE_LABEL="${CHAINCODE_NAME}_${CHAINCODE_VERSION}"

echo "============================================================"
echo " SIH 2026 — Deploying Chaincode: $CHAINCODE_NAME v$CHAINCODE_VERSION"
echo " Source: $CHAINCODE_SRC"
echo "============================================================"

# Helper to set peer environment
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
# STEP 1: Build the TypeScript chaincode
# ============================================================
echo "[1/5] Building chaincode..."
cd "$CHAINCODE_SRC"
npm install --silent
npm run build
echo "      ✓ Chaincode built"

# ============================================================
# STEP 2: Package chaincode
# ============================================================
echo "[2/5] Packaging chaincode..."
PACKAGE_DIR="/tmp/sih-chaincode-pkg"
mkdir -p "$PACKAGE_DIR"

cd "$NETWORK_DIR"

if [ ! -f "$PACKAGE_DIR/${CHAINCODE_LABEL}.tar.gz" ]; then
    peer lifecycle chaincode package "$PACKAGE_DIR/${CHAINCODE_LABEL}.tar.gz" \
        --path "$CHAINCODE_SRC" \
        --lang node \
        --label "$CHAINCODE_LABEL"
    echo "      ✓ Packaged: $PACKAGE_DIR/${CHAINCODE_LABEL}.tar.gz"
else
    echo "      Package already exists. Skipping."
fi

# ============================================================
# STEP 3: Install on all five peers
# ============================================================
echo "[3/5] Installing chaincode on all peers..."

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

    echo "      Installing on $MSP ($DOMAIN:$PORT)..."
    peer lifecycle chaincode install "$PACKAGE_DIR/${CHAINCODE_LABEL}.tar.gz" 2>&1 | tail -3
    echo "      ✓ Installed on $MSP"
done

# ============================================================
# STEP 4: Get package ID and approve for all orgs
# ============================================================
echo "[4/5] Approving chaincode for all organizations..."

# Get package ID (use regulatory peer to query)
set_peer_env "RegulatoryDepartmentMSP" "regulatorydepartment.example.com" "7051"
PACKAGE_ID=$(peer lifecycle chaincode queryinstalled \
    --output json 2>/dev/null | \
    python3 -c "import sys,json; data=json.load(sys.stdin); \
    cc=[c for c in data.get('installed_chaincodes',[]) if c['label']=='${CHAINCODE_LABEL}']; \
    print(cc[0]['package_id'] if cc else '')" 2>/dev/null)

if [ -z "$PACKAGE_ID" ]; then
    echo "ERROR: Could not determine package ID. Is chaincode installed?"
    exit 1
fi

echo "      Package ID: $PACKAGE_ID"

# Approve from all five orgs
for PEER_INFO in "${PEERS[@]}"; do
    IFS=":" read -r MSP DOMAIN PORT <<< "$PEER_INFO"
    set_peer_env "$MSP" "$DOMAIN" "$PORT"

    echo "      Approving from $MSP..."
    peer lifecycle chaincode approveformyorg \
        -o "$ORDERER_ADDR" \
        --ordererTLSHostnameOverride "orderer.example.com" \
        --channelID "$CHANNEL_ID" \
        --name "$CHAINCODE_NAME" \
        --version "$CHAINCODE_VERSION" \
        --package-id "$PACKAGE_ID" \
        --sequence "$CHAINCODE_SEQUENCE" \
        --tls \
        --cafile "$ORDERER_CA" \
        2>&1 | tail -3
    echo "      ✓ Approved: $MSP"
done

# ============================================================
# STEP 5: Commit chaincode definition
# ============================================================
echo "[5/5] Committing chaincode to $CHANNEL_ID..."

# Check commit readiness
set_peer_env "RegulatoryDepartmentMSP" "regulatorydepartment.example.com" "7051"
echo "      Checking commit readiness..."
peer lifecycle chaincode checkcommitreadiness \
    --channelID "$CHANNEL_ID" \
    --name "$CHAINCODE_NAME" \
    --version "$CHAINCODE_VERSION" \
    --sequence "$CHAINCODE_SEQUENCE" \
    --tls \
    --cafile "$ORDERER_CA" \
    --output json 2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
approvals = data.get('approvals', {})
all_approved = all(approvals.values())
for org, approved in approvals.items():
    status = '✓' if approved else '✗'
    print(f'      {status} {org}')
if not all_approved:
    print('ERROR: Not all orgs approved!')
    sys.exit(1)
print('      All orgs approved — committing...')
"

# Build --peerAddresses and --tlsRootCertFiles args for commit
PEER_ARGS=""
TLS_ARGS=""
declare -a PEER_DATA=(
    "regulatorydepartment.example.com:7051"
    "producer.example.com:8051"
    "manufacturer.example.com:9051"
    "deliverer.example.com:10051"
    "retailer.example.com:11051"
)

for PEER_DATA_ITEM in "${PEER_DATA[@]}"; do
    IFS=":" read -r DOMAIN PORT <<< "$PEER_DATA_ITEM"
    PEER_ARGS="$PEER_ARGS --peerAddresses localhost:$PORT"
    TLS_ARGS="$TLS_ARGS --tlsRootCertFiles $ORG_DIR/$DOMAIN/tlsca/tlsca.${DOMAIN}-cert.pem"
done

set_peer_env "RegulatoryDepartmentMSP" "regulatorydepartment.example.com" "7051"

peer lifecycle chaincode commit \
    -o "$ORDERER_ADDR" \
    --ordererTLSHostnameOverride "orderer.example.com" \
    --channelID "$CHANNEL_ID" \
    --name "$CHAINCODE_NAME" \
    --version "$CHAINCODE_VERSION" \
    --sequence "$CHAINCODE_SEQUENCE" \
    --tls \
    --cafile "$ORDERER_CA" \
    $PEER_ARGS \
    $TLS_ARGS \
    2>&1 | tail -5

echo ""
echo "============================================================"
echo " ✓ Chaincode '$CHAINCODE_NAME' v$CHAINCODE_VERSION COMMITTED"
echo " Channel  : $CHANNEL_ID"
echo " Package  : $PACKAGE_ID"
echo ""
echo " Verify with:"
echo "   peer lifecycle chaincode querycommitted --channelID $CHANNEL_ID --name $CHAINCODE_NAME"
echo "============================================================"

# Quick verification
set_peer_env "RegulatoryDepartmentMSP" "regulatorydepartment.example.com" "7051"
peer lifecycle chaincode querycommitted \
    --channelID "$CHANNEL_ID" \
    --name "$CHAINCODE_NAME" \
    --output json 2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(f\"   Name     : {data.get('name')}\")
print(f\"   Version  : {data.get('version')}\")
print(f\"   Sequence : {data.get('sequence')}\")
" 2>/dev/null || echo "   (querycommitted not available — check peer logs)"
