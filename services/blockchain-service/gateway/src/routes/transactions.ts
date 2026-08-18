import { Router, Request, Response, NextFunction } from 'express';
import { submitTransaction, evaluateQuery } from '../controllers/transactionController';
import { idempotencyMiddleware } from '../middleware/idempotency';

const router = Router();

// ============================================================
// Helper: map named body fields to ordered chaincode args array
// ============================================================
const wrapSubmit = (functionName: string, argNames: string[]) =>
    (req: Request, res: Response, next: NextFunction) => {
        const args = argNames.map(name => {
            const val = req.body[name];
            return val !== undefined ? val : '';
        });
        req.body = { functionName, args };
        next();
    };

const wrapEvaluate = (functionName: string, argNames: string[]) =>
    (req: Request, res: Response, next: NextFunction) => {
        const args = argNames.map(name => {
            // Support both body and params
            const val = req.body[name] ?? req.params[name];
            return val !== undefined ? val : '';
        });
        req.body = { functionName, args };
        next();
    };

// ============================================================
// STATE-CHANGING TRANSACTIONS (POST) — require idempotency key
// ============================================================
router.use(idempotencyMiddleware);

// Product
router.post(
    '/products',
    wrapSubmit('registerProduct', ['productId', 'name', 'productType']),
    submitTransaction
);
router.post(
    '/products/:id/block',
    wrapSubmit('blockProduct', ['productId', 'reason']),
    submitTransaction
);
router.post(
    '/products/:id/unblock',
    wrapSubmit('unblockProduct', ['productId', 'reason']),
    submitTransaction
);

// Batch
router.post(
    '/batches',
    wrapSubmit('registerBatch', ['batchId', 'productId', 'quantity', 'metadataJson']),
    submitTransaction
);
router.post(
    '/batches/:id/validate',
    (req, _res, next) => { req.body.batchId = req.body.batchId || req.params.id; next(); },
    wrapSubmit('validateBatch', ['batchId', 'validationResult', 'metadataJson']),
    submitTransaction
);
router.post(
    '/batches/:id/process',
    (req, _res, next) => { req.body.batchId = req.body.batchId || req.params.id; next(); },
    wrapSubmit('processBatch', ['batchId', 'metadataJson']),
    submitTransaction
);
router.post(
    '/batches/:id/make-available',
    (req, _res, next) => { req.body.batchId = req.body.batchId || req.params.id; next(); },
    wrapSubmit('makeAvailable', ['batchId', 'metadataJson']),
    submitTransaction
);
router.post(
    '/batches/:id/block',
    (req, _res, next) => { req.body.batchId = req.body.batchId || req.params.id; next(); },
    wrapSubmit('blockBatch', ['batchId', 'reason']),
    submitTransaction
);
router.post(
    '/batches/:id/unblock',
    (req, _res, next) => { req.body.batchId = req.body.batchId || req.params.id; next(); },
    wrapSubmit('unblockBatch', ['batchId', 'reason']),
    submitTransaction
);
router.post(
    '/batches/:id/recall',
    (req, _res, next) => { req.body.batchId = req.body.batchId || req.params.id; next(); },
    wrapSubmit('recallBatch', ['batchId', 'reason']),
    submitTransaction
);

// Transfer / Receive
router.post(
    '/transfer',
    wrapSubmit('transferBatch', ['batchId', 'targetOrg', 'metadataJson']),
    submitTransaction
);
router.post(
    '/receive',
    wrapSubmit('receiveBatch', ['batchId', 'metadataJson']),
    submitTransaction
);

// Transformation
router.post(
    '/transform',
    wrapSubmit('createTransformation', ['parentBatchIds', 'childBatchId', 'newProductId', 'metadataJson']),
    submitTransaction
);

// Units
router.post(
    '/units',
    wrapSubmit('createUnit', ['batchId', 'unitId']),
    submitTransaction
);

// ============================================================
// READ-ONLY QUERIES (GET) — no idempotency key needed
// ============================================================
router.get('/products/:id', (req, res, next) => {
    req.body = { functionName: 'getProduct', args: [req.params.id] };
    evaluateQuery(req, res, next);
});

router.get('/batches/:id', (req, res, next) => {
    req.body = { functionName: 'getBatch', args: [req.params.id] };
    evaluateQuery(req, res, next);
});

router.get('/batches/:id/history', (req, res, next) => {
    req.body = { functionName: 'getBatchHistory', args: [req.params.id] };
    evaluateQuery(req, res, next);
});

router.get('/units/:id', (req, res, next) => {
    req.body = { functionName: 'getUnit', args: [req.params.id] };
    evaluateQuery(req, res, next);
});

router.get('/units/:id/verify', (req, res, next) => {
    req.body = { functionName: 'verifyUnit', args: [req.params.id] };
    evaluateQuery(req, res, next);
});

export default router;
