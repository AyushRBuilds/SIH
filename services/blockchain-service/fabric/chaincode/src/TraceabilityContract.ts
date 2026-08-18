import { Context, Contract, Info, Returns, Transaction } from 'fabric-contract-api';
import { Product } from './models/Product';
import { Batch, BatchState } from './models/Batch';
import { Unit } from './models/Unit';

// ============================================================
// Five-Organization MSP Constants
// ============================================================
const REGULATORY_MSP = 'RegulatoryDepartmentMSP';
const PRODUCER_MSP = 'ProducerMSP';
const MANUFACTURER_MSP = 'ManufacturerMSP';
const DELIVERER_MSP = 'DelivererMSP';
const RETAILER_MSP = 'RetailerMSP';

const ALL_ORGS = [REGULATORY_MSP, PRODUCER_MSP, MANUFACTURER_MSP, DELIVERER_MSP, RETAILER_MSP];

@Info({
    title: 'TraceabilityContract',
    description: 'SIH 2026 Food Traceability — Smart contract managing the full supply-chain lifecycle for food batches across five organizations.'
})
export class TraceabilityContract extends Contract {

    // ============================================================
    // Private Helpers
    // ============================================================

    /**
     * Safely parse a JSON metadata string. Returns empty object on failure or empty input.
     */
    private parseMetadata(metadataJson: string): Record<string, any> {
        if (!metadataJson || metadataJson.trim() === '') return {};
        try {
            return JSON.parse(metadataJson);
        } catch {
            return {};
        }
    }

    /**
     * Get the current transaction timestamp as an ISO-8601 string.
     */
    private getTimestamp(ctx: Context): string {
        return ctx.stub.getDateTimestamp().toISOString();
    }

    /**
     * Emit a Fabric chaincode event with a standardised envelope containing:
     * event_type, submitting_msp, transaction_id, and emitted_at.
     */
    private emitEvent(ctx: Context, eventName: string, payload: Record<string, any>): void {
        const envelope = {
            ...payload,
            event_type: eventName,
            submitting_msp: ctx.clientIdentity.getMSPID(),
            transaction_id: ctx.stub.getTxID(),
            emitted_at: this.getTimestamp(ctx),
        };
        ctx.stub.setEvent(eventName, Buffer.from(JSON.stringify(envelope)));
    }

    /**
     * Assert the calling MSP is in the allowed list, or throw.
     */
    private requireOrg(mspId: string, allowed: string[], action: string): void {
        if (!allowed.includes(mspId)) {
            throw new Error(
                `Authorization denied: ${action} requires one of [${allowed.join(', ')}]. Got: ${mspId}`
            );
        }
    }

    // ============================================================
    // PRODUCT FUNCTIONS
    // ============================================================

    /**
     * Register a new product type on the ledger.
     * Allowed: ProducerMSP, ManufacturerMSP
     */
    @Transaction()
    public async registerProduct(
        ctx: Context,
        productId: string,
        name: string,
        productType: string
    ): Promise<void> {
        const mspId = ctx.clientIdentity.getMSPID();
        this.requireOrg(mspId, [PRODUCER_MSP, MANUFACTURER_MSP], 'registerProduct');

        const existing = await ctx.stub.getState(`PRODUCT_${productId}`);
        if (existing && existing.length > 0) {
            throw new Error(`Product ${productId} already exists`);
        }

        const product = new Product(productId, name, productType, mspId, this.getTimestamp(ctx));
        await ctx.stub.putState(`PRODUCT_${productId}`, Buffer.from(JSON.stringify(product)));

        this.emitEvent(ctx, 'PRODUCT_REGISTERED', {
            product_id: productId,
            name,
            product_type: productType,
            created_by_org: mspId,
            state: 'ACTIVE',
        });
    }

    /**
     * Read a product from the ledger (read-only evaluate, no transaction).
     */
    @Transaction(false)
    @Returns('string')
    public async getProduct(ctx: Context, productId: string): Promise<string> {
        const bytes = await ctx.stub.getState(`PRODUCT_${productId}`);
        if (!bytes || bytes.length === 0) {
            throw new Error(`Product ${productId} does not exist`);
        }
        return bytes.toString();
    }

    /**
     * Block a product, preventing new batches from being registered for it.
     * Allowed: RegulatoryDepartmentMSP only
     */
    @Transaction()
    public async blockProduct(ctx: Context, productId: string, reason: string): Promise<void> {
        const mspId = ctx.clientIdentity.getMSPID();
        this.requireOrg(mspId, [REGULATORY_MSP], 'blockProduct');

        const bytes = await ctx.stub.getState(`PRODUCT_${productId}`);
        if (!bytes || bytes.length === 0) {
            throw new Error(`Product ${productId} does not exist`);
        }

        const product = JSON.parse(bytes.toString());
        const prevState = product.blocked ? 'BLOCKED' : 'ACTIVE';

        product.blocked = true;
        product.block_reason = reason;
        product.blocked_by = mspId;
        product.blocked_at = this.getTimestamp(ctx);
        product.updated_at = this.getTimestamp(ctx);

        await ctx.stub.putState(`PRODUCT_${productId}`, Buffer.from(JSON.stringify(product)));

        this.emitEvent(ctx, 'PRODUCT_BLOCKED', {
            product_id: productId,
            reason,
            previous_state: prevState,
            state: 'BLOCKED',
        });
    }

    /**
     * Unblock a previously blocked product.
     * Allowed: RegulatoryDepartmentMSP only
     */
    @Transaction()
    public async unblockProduct(ctx: Context, productId: string, reason: string): Promise<void> {
        const mspId = ctx.clientIdentity.getMSPID();
        this.requireOrg(mspId, [REGULATORY_MSP], 'unblockProduct');

        const bytes = await ctx.stub.getState(`PRODUCT_${productId}`);
        if (!bytes || bytes.length === 0) {
            throw new Error(`Product ${productId} does not exist`);
        }

        const product = JSON.parse(bytes.toString());
        product.blocked = false;
        product.block_reason = null;
        product.unblocked_by = mspId;
        product.unblocked_reason = reason;
        product.updated_at = this.getTimestamp(ctx);

        await ctx.stub.putState(`PRODUCT_${productId}`, Buffer.from(JSON.stringify(product)));

        this.emitEvent(ctx, 'PRODUCT_UNBLOCKED', {
            product_id: productId,
            reason,
            state: 'ACTIVE',
        });
    }

    // ============================================================
    // BATCH FUNCTIONS
    // ============================================================

    /**
     * Register a new batch on the ledger.
     * Allowed: ProducerMSP, ManufacturerMSP
     */
    @Transaction()
    public async registerBatch(
        ctx: Context,
        batchId: string,
        productId: string,
        quantity: string,
        metadataJson: string = ''
    ): Promise<void> {
        const mspId = ctx.clientIdentity.getMSPID();
        this.requireOrg(mspId, [PRODUCER_MSP, MANUFACTURER_MSP], 'registerBatch');

        // Verify product exists and is not blocked
        const productBytes = await ctx.stub.getState(`PRODUCT_${productId}`);
        if (!productBytes || productBytes.length === 0) {
            throw new Error(`Product ${productId} does not exist`);
        }
        const product = JSON.parse(productBytes.toString());
        if (product.blocked) {
            throw new Error(`Product ${productId} is blocked and cannot accept new batches`);
        }

        // Check batch uniqueness
        const existingBatch = await ctx.stub.getState(`BATCH_${batchId}`);
        if (existingBatch && existingBatch.length > 0) {
            throw new Error(`Batch ${batchId} already exists`);
        }

        const metadata = this.parseMetadata(metadataJson);
        const now = this.getTimestamp(ctx);

        const batchObj: Record<string, any> = {
            docType: 'batch',
            batch_id: batchId,
            product_id: productId,
            state: BatchState.REGISTERED,
            current_custodian: mspId,
            parent_refs: [],
            quantity,
            created_at: now,
            updated_at: now,
            // Merge metadata fields (location, conditions, etc.)
            ...metadata,
        };

        await ctx.stub.putState(`BATCH_${batchId}`, Buffer.from(JSON.stringify(batchObj)));

        this.emitEvent(ctx, 'BATCH_REGISTERED', {
            batch_id: batchId,
            product_id: productId,
            quantity,
            state: BatchState.REGISTERED,
            current_custodian: mspId,
            ...metadata,
        });
    }

    /**
     * Read a batch from the ledger (read-only evaluate, no transaction).
     */
    @Transaction(false)
    @Returns('string')
    public async getBatch(ctx: Context, batchId: string): Promise<string> {
        const bytes = await ctx.stub.getState(`BATCH_${batchId}`);
        if (!bytes || bytes.length === 0) {
            throw new Error(`Batch ${batchId} does not exist`);
        }
        return bytes.toString();
    }

    /**
     * Retrieve the full key history for a batch (for lineage/audit trail).
     * Read-only evaluate.
     */
    @Transaction(false)
    @Returns('string')
    public async getBatchHistory(ctx: Context, batchId: string): Promise<string> {
        const iterator = await ctx.stub.getHistoryForKey(`BATCH_${batchId}`);
        const history: Record<string, any>[] = [];

        while (true) {
            const result = await iterator.next();
            if (result.done) break;

            const entry: Record<string, any> = {
                tx_id: result.value.txId,
                timestamp: result.value.timestamp
                    ? new Date(
                          (result.value.timestamp as any).seconds.toNumber() * 1000
                      ).toISOString()
                    : null,
                is_delete: result.value.isDelete,
                value: null,
            };

            if (!result.value.isDelete && result.value.value) {
                try {
                    entry.value = JSON.parse(result.value.value.toString());
                } catch {
                    entry.value = result.value.value.toString();
                }
            }

            history.push(entry);
        }

        await iterator.close();
        return JSON.stringify(history);
    }

    /**
     * Validate (or invalidate) a batch. Only RegulatoryDepartmentMSP may call this.
     * Allowed: RegulatoryDepartmentMSP only
     *
     * NOTE: The producer is the current_custodian at registration time, so the old check
     * (current_custodian === mspId) was WRONG — it blocked the regulator from validating.
     */
    @Transaction()
    public async validateBatch(
        ctx: Context,
        batchId: string,
        validationResult: string,
        metadataJson: string = ''
    ): Promise<void> {
        const mspId = ctx.clientIdentity.getMSPID();
        // BUG-8 FIX: Only the regulator can validate — not the custodian
        this.requireOrg(mspId, [REGULATORY_MSP], 'validateBatch');

        const batchBytes = await ctx.stub.getState(`BATCH_${batchId}`);
        if (!batchBytes || batchBytes.length === 0) {
            throw new Error(`Batch ${batchId} does not exist`);
        }
        const batch = JSON.parse(batchBytes.toString());

        if (batch.state !== BatchState.REGISTERED) {
            throw new Error(
                `Invalid state transition: validateBatch requires state REGISTERED. Current: ${batch.state}`
            );
        }

        const metadata = this.parseMetadata(metadataJson);

        if (validationResult === 'VALID') {
            batch.state = BatchState.VALIDATED;
        } else {
            batch.state = BatchState.BLOCKED;
            batch.block_reason = metadata.reason || 'Failed regulatory validation';
        }

        batch.updated_at = this.getTimestamp(ctx);
        batch.validated_by = mspId;
        if (metadata.validation_notes) batch.validation_notes = metadata.validation_notes;

        await ctx.stub.putState(`BATCH_${batchId}`, Buffer.from(JSON.stringify(batch)));

        this.emitEvent(ctx, 'BATCH_VALIDATED', {
            batch_id: batchId,
            state: batch.state,
            validation_result: validationResult,
            validated_by: mspId,
            ...metadata,
        });
    }

    /**
     * Transfer custody of a batch to another organisation.
     * Allowed: current custodian only (any MSP that is current_custodian)
     */
    @Transaction()
    public async transferBatch(
        ctx: Context,
        batchId: string,
        targetOrg: string,
        metadataJson: string = ''
    ): Promise<void> {
        const mspId = ctx.clientIdentity.getMSPID();

        const batchBytes = await ctx.stub.getState(`BATCH_${batchId}`);
        if (!batchBytes || batchBytes.length === 0) {
            throw new Error(`Batch ${batchId} does not exist`);
        }
        const batch = JSON.parse(batchBytes.toString());

        if (batch.current_custodian !== mspId) {
            throw new Error(
                `Organization ${mspId} is not the current custodian of batch ${batchId}. Current custodian: ${batch.current_custodian}`
            );
        }

        const transferableStates = [
            BatchState.VALIDATED,
            BatchState.RECEIVED,
            BatchState.PROCESSED,
            BatchState.AVAILABLE,
        ];
        if (!transferableStates.includes(batch.state)) {
            throw new Error(
                `Invalid state transition: Cannot transfer batch in state ${batch.state}. Allowed states: ${transferableStates.join(', ')}`
            );
        }

        if (!ALL_ORGS.includes(targetOrg)) {
            throw new Error(
                `Unknown target organization: ${targetOrg}. Allowed: ${ALL_ORGS.join(', ')}`
            );
        }

        const metadata = this.parseMetadata(metadataJson);
        const prevState = batch.state;

        batch.state = BatchState.IN_TRANSIT;
        batch.pending_custodian = targetOrg;
        batch.updated_at = this.getTimestamp(ctx);
        if (metadata.location_name) batch.last_transfer_location = metadata.location_name;

        await ctx.stub.putState(`BATCH_${batchId}`, Buffer.from(JSON.stringify(batch)));

        this.emitEvent(ctx, 'BATCH_TRANSFERRED', {
            batch_id: batchId,
            from_org: mspId,
            to_org: targetOrg,
            previous_state: prevState,
            state: BatchState.IN_TRANSIT,
            ...metadata,
        });
    }

    /**
     * Accept/receive a batch that is IN_TRANSIT and destined for this organisation.
     * Allowed: the pending_custodian (ManufacturerMSP, DelivererMSP, RetailerMSP)
     */
    @Transaction()
    public async receiveBatch(
        ctx: Context,
        batchId: string,
        metadataJson: string = ''
    ): Promise<void> {
        const mspId = ctx.clientIdentity.getMSPID();

        const batchBytes = await ctx.stub.getState(`BATCH_${batchId}`);
        if (!batchBytes || batchBytes.length === 0) {
            throw new Error(`Batch ${batchId} does not exist`);
        }
        const batch = JSON.parse(batchBytes.toString());

        if (batch.state !== BatchState.IN_TRANSIT) {
            throw new Error(
                `Invalid state transition: receiveBatch requires state IN_TRANSIT. Current: ${batch.state}`
            );
        }

        if (batch.pending_custodian !== mspId) {
            throw new Error(
                `Organization ${mspId} is not the intended recipient. Expected: ${batch.pending_custodian}`
            );
        }

        const metadata = this.parseMetadata(metadataJson);

        batch.state = BatchState.RECEIVED;
        batch.current_custodian = mspId;
        delete batch.pending_custodian;
        batch.updated_at = this.getTimestamp(ctx);
        if (metadata.location_name) batch.last_received_location = metadata.location_name;

        await ctx.stub.putState(`BATCH_${batchId}`, Buffer.from(JSON.stringify(batch)));

        this.emitEvent(ctx, 'BATCH_RECEIVED', {
            batch_id: batchId,
            received_by: mspId,
            state: BatchState.RECEIVED,
            ...metadata,
        });
    }

    /**
     * Process a batch (manufacturing/transformation step).
     * Allowed: ManufacturerMSP only (must be current custodian)
     */
    @Transaction()
    public async processBatch(
        ctx: Context,
        batchId: string,
        metadataJson: string = ''
    ): Promise<void> {
        const mspId = ctx.clientIdentity.getMSPID();
        this.requireOrg(mspId, [MANUFACTURER_MSP], 'processBatch');

        const batchBytes = await ctx.stub.getState(`BATCH_${batchId}`);
        if (!batchBytes || batchBytes.length === 0) {
            throw new Error(`Batch ${batchId} does not exist`);
        }
        const batch = JSON.parse(batchBytes.toString());

        if (batch.current_custodian !== mspId) {
            throw new Error(
                `Organization ${mspId} is not the current custodian`
            );
        }

        if (batch.state !== BatchState.RECEIVED) {
            throw new Error(
                `Invalid state transition: processBatch requires state RECEIVED. Current: ${batch.state}`
            );
        }

        const metadata = this.parseMetadata(metadataJson);

        batch.state = BatchState.PROCESSED;
        batch.updated_at = this.getTimestamp(ctx);
        if (metadata.process_notes) batch.process_notes = metadata.process_notes;

        await ctx.stub.putState(`BATCH_${batchId}`, Buffer.from(JSON.stringify(batch)));

        this.emitEvent(ctx, 'BATCH_PROCESSED', {
            batch_id: batchId,
            processed_by: mspId,
            state: BatchState.PROCESSED,
            ...metadata,
        });
    }

    /**
     * Mark a received batch as AVAILABLE (ready for consumer).
     * Allowed: RetailerMSP only (must be current custodian)
     */
    @Transaction()
    public async makeAvailable(
        ctx: Context,
        batchId: string,
        metadataJson: string = ''
    ): Promise<void> {
        const mspId = ctx.clientIdentity.getMSPID();
        this.requireOrg(mspId, [RETAILER_MSP], 'makeAvailable');

        const batchBytes = await ctx.stub.getState(`BATCH_${batchId}`);
        if (!batchBytes || batchBytes.length === 0) {
            throw new Error(`Batch ${batchId} does not exist`);
        }
        const batch = JSON.parse(batchBytes.toString());

        if (batch.current_custodian !== mspId) {
            throw new Error(
                `Organization ${mspId} is not the current custodian`
            );
        }

        if (batch.state !== BatchState.RECEIVED) {
            throw new Error(
                `Invalid state transition: makeAvailable requires state RECEIVED. Current: ${batch.state}`
            );
        }

        const metadata = this.parseMetadata(metadataJson);

        batch.state = BatchState.AVAILABLE;
        batch.updated_at = this.getTimestamp(ctx);

        await ctx.stub.putState(`BATCH_${batchId}`, Buffer.from(JSON.stringify(batch)));

        this.emitEvent(ctx, 'BATCH_AVAILABLE', {
            batch_id: batchId,
            made_available_by: mspId,
            state: BatchState.AVAILABLE,
            ...metadata,
        });
    }

    /**
     * Block a batch (remove from supply chain circulation).
     * Allowed: RegulatoryDepartmentMSP only
     */
    @Transaction()
    public async blockBatch(ctx: Context, batchId: string, reason: string): Promise<void> {
        const mspId = ctx.clientIdentity.getMSPID();
        // BUG-6 FIX: Correct MSP string — was 'RegulatorOrg' (wrong)
        this.requireOrg(mspId, [REGULATORY_MSP], 'blockBatch');

        const bytes = await ctx.stub.getState(`BATCH_${batchId}`);
        if (!bytes || bytes.length === 0) {
            throw new Error(`Batch ${batchId} does not exist`);
        }

        const batch = JSON.parse(bytes.toString());
        if (batch.state === BatchState.RECALLED) {
            throw new Error(`Batch ${batchId} is already RECALLED and cannot be blocked`);
        }

        const prevState = batch.state;
        batch.state = BatchState.BLOCKED;
        batch.block_reason = reason;
        batch.blocked_by = mspId;
        batch.blocked_at = this.getTimestamp(ctx);
        batch.updated_at = this.getTimestamp(ctx);

        await ctx.stub.putState(`BATCH_${batchId}`, Buffer.from(JSON.stringify(batch)));

        this.emitEvent(ctx, 'BATCH_BLOCKED', {
            batch_id: batchId,
            reason,
            previous_state: prevState,
            state: BatchState.BLOCKED,
        });
    }

    /**
     * Unblock a batch, returning it to VALIDATED state.
     * Allowed: RegulatoryDepartmentMSP only
     */
    @Transaction()
    public async unblockBatch(ctx: Context, batchId: string, reason: string): Promise<void> {
        const mspId = ctx.clientIdentity.getMSPID();
        this.requireOrg(mspId, [REGULATORY_MSP], 'unblockBatch');

        const bytes = await ctx.stub.getState(`BATCH_${batchId}`);
        if (!bytes || bytes.length === 0) {
            throw new Error(`Batch ${batchId} does not exist`);
        }

        const batch = JSON.parse(bytes.toString());
        if (batch.state !== BatchState.BLOCKED) {
            throw new Error(
                `Batch ${batchId} is not BLOCKED. Cannot unblock. Current state: ${batch.state}`
            );
        }

        batch.state = BatchState.VALIDATED;
        batch.block_reason = null;
        batch.unblocked_by = mspId;
        batch.unblocked_reason = reason;
        batch.updated_at = this.getTimestamp(ctx);

        await ctx.stub.putState(`BATCH_${batchId}`, Buffer.from(JSON.stringify(batch)));

        this.emitEvent(ctx, 'BATCH_UNBLOCKED', {
            batch_id: batchId,
            reason,
            state: BatchState.VALIDATED,
        });
    }

    /**
     * Recall a batch (permanent — cannot be reversed).
     * Allowed: RegulatoryDepartmentMSP only
     */
    @Transaction()
    public async recallBatch(ctx: Context, batchId: string, reason: string): Promise<void> {
        const mspId = ctx.clientIdentity.getMSPID();
        this.requireOrg(mspId, [REGULATORY_MSP], 'recallBatch');

        const bytes = await ctx.stub.getState(`BATCH_${batchId}`);
        if (!bytes || bytes.length === 0) {
            throw new Error(`Batch ${batchId} does not exist`);
        }

        const batch = JSON.parse(bytes.toString());
        if (batch.state === BatchState.RECALLED) {
            throw new Error(`Batch ${batchId} is already RECALLED`);
        }

        const prevState = batch.state;
        batch.state = BatchState.RECALLED;
        batch.recall_reason = reason;
        batch.recalled_by = mspId;
        batch.recalled_at = this.getTimestamp(ctx);
        batch.updated_at = this.getTimestamp(ctx);

        await ctx.stub.putState(`BATCH_${batchId}`, Buffer.from(JSON.stringify(batch)));

        this.emitEvent(ctx, 'RECALL_CREATED', {
            batch_id: batchId,
            reason,
            previous_state: prevState,
            state: BatchState.RECALLED,
        });
    }

    // ============================================================
    // TRANSFORMATION FUNCTIONS
    // ============================================================

    /**
     * Create a derived/transformed batch from one or more parent batches.
     * Preserves parent-child lineage.
     * Allowed: ManufacturerMSP only (must be current custodian of all parents)
     */
    @Transaction()
    public async createTransformation(
        ctx: Context,
        parentBatchIdsStr: string,
        childBatchId: string,
        newProductId: string,
        metadataJson: string = ''
    ): Promise<void> {
        const mspId = ctx.clientIdentity.getMSPID();
        this.requireOrg(mspId, [MANUFACTURER_MSP], 'createTransformation');

        const parentBatchIds: string[] = JSON.parse(parentBatchIdsStr);

        for (const parentId of parentBatchIds) {
            const parentBytes = await ctx.stub.getState(`BATCH_${parentId}`);
            if (!parentBytes || parentBytes.length === 0) {
                throw new Error(`Parent batch ${parentId} does not exist`);
            }
            const parent = JSON.parse(parentBytes.toString());

            if (parent.current_custodian !== mspId) {
                throw new Error(
                    `Organization ${mspId} does not have custody of parent batch ${parentId}. Current custodian: ${parent.current_custodian}`
                );
            }

            const validParentStates = [BatchState.PROCESSED, BatchState.RECEIVED];
            if (!validParentStates.includes(parent.state)) {
                throw new Error(
                    `Parent batch ${parentId} is in state ${parent.state}. Must be PROCESSED or RECEIVED to transform.`
                );
            }
        }

        const existingChild = await ctx.stub.getState(`BATCH_${childBatchId}`);
        if (existingChild && existingChild.length > 0) {
            throw new Error(`Child batch ${childBatchId} already exists`);
        }

        // Verify new product exists
        const productBytes = await ctx.stub.getState(`PRODUCT_${newProductId}`);
        if (!productBytes || productBytes.length === 0) {
            throw new Error(`Product ${newProductId} does not exist`);
        }

        const metadata = this.parseMetadata(metadataJson);
        const now = this.getTimestamp(ctx);

        const childBatch: Record<string, any> = {
            docType: 'batch',
            batch_id: childBatchId,
            product_id: newProductId,
            state: BatchState.PROCESSED,
            current_custodian: mspId,
            parent_refs: parentBatchIds,
            created_at: now,
            updated_at: now,
            ...metadata,
        };

        await ctx.stub.putState(`BATCH_${childBatchId}`, Buffer.from(JSON.stringify(childBatch)));

        this.emitEvent(ctx, 'TRANSFORMATION_CREATED', {
            child_batch_id: childBatchId,
            parent_batch_ids: parentBatchIds,
            new_product_id: newProductId,
            state: BatchState.PROCESSED,
            created_by: mspId,
            ...metadata,
        });
    }

    // ============================================================
    // UNIT FUNCTIONS
    // ============================================================

    /**
     * Create a consumer-facing traceable unit from a batch.
     * Allowed: RetailerMSP, ManufacturerMSP (must be current custodian)
     */
    @Transaction()
    public async createUnit(ctx: Context, batchId: string, unitId: string): Promise<void> {
        const mspId = ctx.clientIdentity.getMSPID();
        this.requireOrg(mspId, [RETAILER_MSP, MANUFACTURER_MSP], 'createUnit');

        const batchBytes = await ctx.stub.getState(`BATCH_${batchId}`);
        if (!batchBytes || batchBytes.length === 0) {
            throw new Error(`Batch ${batchId} does not exist`);
        }
        const batch = JSON.parse(batchBytes.toString());

        if (batch.current_custodian !== mspId) {
            throw new Error(
                `Organization ${mspId} is not the current custodian`
            );
        }

        if ([BatchState.BLOCKED, BatchState.RECALLED].includes(batch.state)) {
            throw new Error(
                `Cannot create unit from batch in state ${batch.state}`
            );
        }

        const existingUnit = await ctx.stub.getState(`UNIT_${unitId}`);
        if (existingUnit && existingUnit.length > 0) {
            throw new Error(`Unit ${unitId} already exists`);
        }

        const now = this.getTimestamp(ctx);
        const unit = new Unit(unitId, batchId, batch.state, mspId, now, now);

        await ctx.stub.putState(`UNIT_${unitId}`, Buffer.from(JSON.stringify(unit)));

        this.emitEvent(ctx, 'UNIT_CREATED', {
            unit_id: unitId,
            batch_id: batchId,
            product_id: batch.product_id,
            state: batch.state,
            created_by: mspId,
        });
    }

    /**
     * Read a unit from the ledger (read-only evaluate, no transaction).
     */
    @Transaction(false)
    @Returns('string')
    public async getUnit(ctx: Context, unitId: string): Promise<string> {
        const bytes = await ctx.stub.getState(`UNIT_${unitId}`);
        if (!bytes || bytes.length === 0) {
            throw new Error(`Unit ${unitId} does not exist`);
        }
        return bytes.toString();
    }

    /**
     * Verify a unit: returns the unit's current on-chain state.
     * Read-only evaluate — used by QR verification flow.
     */
    @Transaction(false)
    @Returns('string')
    public async verifyUnit(ctx: Context, unitId: string): Promise<string> {
        const unitBytes = await ctx.stub.getState(`UNIT_${unitId}`);
        if (!unitBytes || unitBytes.length === 0) {
            throw new Error(`Unit ${unitId} does not exist`);
        }
        const unit = JSON.parse(unitBytes.toString());

        const batchBytes = await ctx.stub.getState(`BATCH_${unit.batch_id}`);
        if (!batchBytes || batchBytes.length === 0) {
            return JSON.stringify({
                unit_id: unitId,
                unit,
                batch: null,
                verified: false,
                error: `Batch ${unit.batch_id} not found`,
            });
        }
        const batch = JSON.parse(batchBytes.toString());

        const productBytes = await ctx.stub.getState(`PRODUCT_${batch.product_id}`);
        const product = (productBytes && productBytes.length > 0)
            ? JSON.parse(productBytes.toString())
            : null;

        const isBlocked = batch.state === BatchState.BLOCKED || batch.state === BatchState.RECALLED
            || (product && product.blocked);

        return JSON.stringify({
            unit_id: unitId,
            unit,
            batch,
            product,
            verified: !isBlocked,
            blocked: isBlocked,
        });
    }
}
