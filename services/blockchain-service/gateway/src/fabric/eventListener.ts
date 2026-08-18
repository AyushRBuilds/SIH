import { fabricManager } from './fabricManager';
import axios from 'axios';
import { ChaincodeEvent } from '@hyperledger/fabric-gateway';

// ============================================================
// Required environment variables
// ============================================================
for (const envVar of ['WEBHOOK_URL', 'INTERNAL_API_KEY', 'EVENT_LISTENER_MSP', 'CHANNEL_NAME', 'CHAINCODE_NAME']) {
    if (!process.env[envVar]) {
        throw new Error(`CRITICAL: ${envVar} environment variable is not defined.`);
    }
}

const WEBHOOK_URL = process.env.WEBHOOK_URL!;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY!;
const EVENT_LISTENER_MSP = process.env.EVENT_LISTENER_MSP!;
const CHANNEL_NAME = process.env.CHANNEL_NAME!;
// BUG-12 FIX: Use CHAINCODE_NAME env var — never hardcode 'traceability'
const CHAINCODE_NAME = process.env.CHAINCODE_NAME!;

const MAX_RETRIES = 5;
const utf8Decoder = new TextDecoder();

// ============================================================
// Checkpoint: track last processed block to survive restarts
// ============================================================
// In production, persist this to Redis or a file. For now, in-memory
// (events will replay from block 0 on restart — idempotency in D3/D1
// prevents duplicates via the fabric_tx_id UNIQUE constraint).
let lastProcessedBlock = BigInt(0);

export async function startEventListener(): Promise<void> {
    console.log(`[EventListener] Starting on channel=${CHANNEL_NAME} chaincode=${CHAINCODE_NAME} msp=${EVENT_LISTENER_MSP}`);

    try {
        const network = await fabricManager.getNetwork(EVENT_LISTENER_MSP);

        // BUG-12 FIX: use env var, not hardcoded string
        const eventIterator = await network.getChaincodeEvents(CHAINCODE_NAME, {
            // Resume from last known block (0 = from genesis, fine for demo)
            startBlock: lastProcessedBlock > BigInt(0) ? lastProcessedBlock : undefined,
        });

        console.log(`[EventListener] Listening for chaincode events...`);

        for await (const event of eventIterator) {
            await processEvent(event);
            // Update checkpoint
            if (event.blockNumber > lastProcessedBlock) {
                lastProcessedBlock = event.blockNumber;
            }
        }

    } catch (error: any) {
        console.error('[EventListener] Error — closing gateway and restarting in 5s...', error.message);
        // Close cached gateway so next reconnect gets a fresh connection
        fabricManager.closeGateway(EVENT_LISTENER_MSP);
        setTimeout(startEventListener, 5000);
    }
}

async function processEvent(event: ChaincodeEvent): Promise<void> {
    const eventName = event.eventName;
    const blockNumber = event.blockNumber;
    const transactionId = event.transactionId;

    let payloadJson: any = null;
    if (event.payload && event.payload.length > 0) {
        const payloadStr = utf8Decoder.decode(event.payload);
        try {
            payloadJson = JSON.parse(payloadStr);
        } catch {
            payloadJson = payloadStr;
        }
    }

    const webhookPayload = {
        transaction_id: transactionId,
        block_number: Number(blockNumber),
        channel_id: CHANNEL_NAME,
        chaincode_id: CHAINCODE_NAME,
        event_name: eventName,
        payload: payloadJson,
        emitted_at: new Date().toISOString(),
    };

    console.log(`[EventListener] Event: ${eventName} | Tx: ${transactionId} | Block: ${blockNumber}`);

    let retries = 0;
    while (retries < MAX_RETRIES) {
        try {
            const response = await axios.post(WEBHOOK_URL, webhookPayload, {
                headers: {
                    Authorization: `Bearer ${INTERNAL_API_KEY}`,
                    'Content-Type': 'application/json',
                },
                timeout: 10000,
            });

            // 200 OK or 409 Conflict (duplicate event already handled) — both are success
            if (response.status === 200 || response.status === 409) {
                console.log(`[EventListener] ✓ Delivered ${eventName} (${response.status})`);
                return;
            }

            throw new Error(`Unexpected response status: ${response.status}`);

        } catch (error: any) {
            retries++;
            const isAxiosError = error.response !== undefined;
            // 409 Conflict = duplicate event, treat as success (idempotency)
            if (isAxiosError && error.response?.status === 409) {
                console.log(`[EventListener] ✓ Duplicate event ${eventName} (409) — idempotency OK`);
                return;
            }

            console.error(
                `[EventListener] Webhook failed (attempt ${retries}/${MAX_RETRIES}): ${error.message}`
            );

            if (retries >= MAX_RETRIES) {
                console.error(
                    `[EventListener] CRITICAL: Dropped event ${eventName} (Tx: ${transactionId}) after ${MAX_RETRIES} attempts.`
                );
                return;
            }

            // Exponential backoff: 2s, 4s, 8s, 16s
            const backoffMs = Math.pow(2, retries) * 1000;
            console.log(`[EventListener] Retrying in ${backoffMs}ms...`);
            await new Promise(resolve => setTimeout(resolve, backoffMs));
        }
    }
}
