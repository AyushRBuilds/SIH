import * as grpc from '@grpc/grpc-js';
import { connect, Contract, Gateway, Network } from '@hyperledger/fabric-gateway';
import * as crypto from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';

// ============================================================
// Required environment variables — fail fast if missing
// ============================================================
for (const envVar of ['CHANNEL_NAME', 'CHAINCODE_NAME', 'CRYPTO_PATH']) {
    if (!process.env[envVar]) {
        throw new Error(`CRITICAL: Environment variable ${envVar} is not defined.`);
    }
}

const channelName = process.env.CHANNEL_NAME!;
const chaincodeName = process.env.CHAINCODE_NAME!;
const cryptoPath = process.env.CRYPTO_PATH!;

// ============================================================
// Five-Organization MSP Configuration
// ============================================================
// Each org maps to: domain, peer gRPC endpoint, peer TLS host alias
// These must match the actual running Fabric network topology.
// Override via environment variables for flexibility.
// ============================================================
interface OrgConfig {
    domain: string;
    peerEndpoint: string;
    peerHostAlias: string;
}

const ORG_CONFIG: Record<string, OrgConfig> = {
    RegulatoryDepartmentMSP: {
        domain: process.env.REGULATORY_DOMAIN || 'regulatorydepartment.example.com',
        peerEndpoint: process.env.REGULATORY_PEER_ENDPOINT || 'localhost:7051',
        peerHostAlias: process.env.REGULATORY_PEER_ALIAS || 'peer0.regulatorydepartment.example.com',
    },
    ProducerMSP: {
        domain: process.env.PRODUCER_DOMAIN || 'producer.example.com',
        peerEndpoint: process.env.PRODUCER_PEER_ENDPOINT || 'localhost:8051',
        peerHostAlias: process.env.PRODUCER_PEER_ALIAS || 'peer0.producer.example.com',
    },
    ManufacturerMSP: {
        domain: process.env.MANUFACTURER_DOMAIN || 'manufacturer.example.com',
        peerEndpoint: process.env.MANUFACTURER_PEER_ENDPOINT || 'localhost:9051',
        peerHostAlias: process.env.MANUFACTURER_PEER_ALIAS || 'peer0.manufacturer.example.com',
    },
    DelivererMSP: {
        domain: process.env.DELIVERER_DOMAIN || 'deliverer.example.com',
        peerEndpoint: process.env.DELIVERER_PEER_ENDPOINT || 'localhost:10051',
        peerHostAlias: process.env.DELIVERER_PEER_ALIAS || 'peer0.deliverer.example.com',
    },
    RetailerMSP: {
        domain: process.env.RETAILER_DOMAIN || 'retailer.example.com',
        peerEndpoint: process.env.RETAILER_PEER_ENDPOINT || 'localhost:11051',
        peerHostAlias: process.env.RETAILER_PEER_ALIAS || 'peer0.retailer.example.com',
    },
};

// ============================================================
// Fabric Connection Manager
// ============================================================
export class FabricConnectionManager {
    private gateways: Map<string, Gateway> = new Map();

    /**
     * Get a Fabric Contract handle for the given MSP organization.
     * Gateways are cached per MSP for connection reuse.
     */
    public async getContract(mspId: string): Promise<Contract> {
        const gateway = await this.getGateway(mspId);
        const network = gateway.getNetwork(channelName);
        return network.getContract(chaincodeName);
    }

    /**
     * Get a Fabric Network handle for the given MSP organization.
     * Used by the event listener to subscribe to chaincode events.
     */
    public async getNetwork(mspId: string): Promise<Network> {
        const gateway = await this.getGateway(mspId);
        return gateway.getNetwork(channelName);
    }

    /**
     * Close and remove the cached gateway for a given MSP (for reconnection).
     */
    public closeGateway(mspId: string): void {
        const gw = this.gateways.get(mspId);
        if (gw) {
            try { gw.close(); } catch { /* ignore */ }
            this.gateways.delete(mspId);
        }
    }

    private async getGateway(mspId: string): Promise<Gateway> {
        if (this.gateways.has(mspId)) {
            return this.gateways.get(mspId)!;
        }

        const orgCfg = ORG_CONFIG[mspId];
        if (!orgCfg) {
            throw new Error(
                `Unsupported MSP ID: "${mspId}". Supported MSPs: ${Object.keys(ORG_CONFIG).join(', ')}`
            );
        }

        const { domain, peerEndpoint, peerHostAlias } = orgCfg;

        // Resolve crypto material paths
        // Expected layout (from cryptogen / fabric-ca):
        //   $CRYPTO_PATH/<domain>/users/Admin@<domain>/msp/signcerts/cert.pem
        //   $CRYPTO_PATH/<domain>/users/Admin@<domain>/msp/keystore/<private_key>
        //   $CRYPTO_PATH/<domain>/peers/<peerHostAlias>/tls/ca.crt
        const orgPath = path.resolve(cryptoPath, domain);
        const adminPath = path.resolve(orgPath, 'users', `Admin@${domain}`);
        const certPath = path.resolve(adminPath, 'msp', 'signcerts', 'cert.pem');
        const keyDirectoryPath = path.resolve(adminPath, 'msp', 'keystore');
        const tlsCertPath = path.resolve(orgPath, 'peers', peerHostAlias, 'tls', 'ca.crt');

        try {
            // Read identity certificate
            const credentials = await fs.readFile(certPath);
            const identity = { mspId, credentials };

            // Read private key (first file in keystore directory)
            const keyFiles = await fs.readdir(keyDirectoryPath);
            if (keyFiles.length === 0) {
                throw new Error(`No key files found in keystore: ${keyDirectoryPath}`);
            }
            const keyPath = path.resolve(keyDirectoryPath, keyFiles[0]);
            const privateKeyPem = await fs.readFile(keyPath);
            const privateKey = crypto.createPrivateKey(privateKeyPem);
            const signer = (await import('@hyperledger/fabric-gateway')).signers.newPrivateKeySigner(privateKey);

            // Read TLS CA certificate for mTLS
            const tlsRootCert = await fs.readFile(tlsCertPath);

            // Create gRPC client with TLS
            const client = new grpc.Client(
                peerEndpoint,
                grpc.credentials.createSsl(tlsRootCert),
                { 'grpc.ssl_target_name_override': peerHostAlias }
            );

            // Connect Fabric Gateway
            const gateway = connect({
                client,
                identity,
                signer,
                evaluateOptions: () => ({ deadline: Date.now() + 10000 }),   // 10s
                endorseOptions: () => ({ deadline: Date.now() + 30000 }),    // 30s
                submitOptions: () => ({ deadline: Date.now() + 10000 }),     // 10s
                commitStatusOptions: () => ({ deadline: Date.now() + 90000 }), // 90s
            });

            this.gateways.set(mspId, gateway);
            console.log(`[FabricManager] Gateway connected for ${mspId} → ${peerEndpoint}`);
            return gateway;

        } catch (error: any) {
            console.error(`[FabricManager] Failed to connect gateway for ${mspId}:`, error.message);
            throw new Error(`Blockchain gateway unavailable for ${mspId}: ${error.message}`);
        }
    }
}

export const fabricManager = new FabricConnectionManager();
