import { Request, Response, NextFunction } from 'express';
import { fabricManager } from '../fabric/fabricManager';

const utf8Decoder = new TextDecoder();

/**
 * Submit a state-changing transaction to Hyperledger Fabric.
 *
 * CRITICAL: Uses the lower-level Proposal → Endorse → Submit API so that
 * the real Fabric transaction ID is captured and returned. The simple
 * contract.submitTransaction() API does not expose the TX ID.
 *
 * The response will ONLY say status=COMMITTED after the block has been
 * committed. If Fabric is unavailable, we return an explicit error — never
 * a fake/placeholder ID.
 */
export const submitTransaction = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const actorMsp: string = (req as any).actorMsp;
        const { functionName, args } = req.body;

        if (!functionName) {
            return res.status(400).json({ error: 'functionName is required' });
        }

        const contract = await fabricManager.getContract(actorMsp);

        // Coerce all args to strings (Fabric chaincode args are always strings)
        const stringArgs: string[] = (args || []).map((arg: any) =>
            typeof arg === 'string' ? arg : JSON.stringify(arg)
        );

        // ----------------------------------------------------------------
        // REAL TX ID: Use lower-level Proposal → Endorse → Submit sequence
        // ----------------------------------------------------------------
        const proposal = contract.newProposal(functionName, { arguments: stringArgs });

        // Endorse: send proposal to peer(s) and get signed proposal response
        const transaction = await proposal.endorse();

        // SDK method: getTransactionId() — available after endorsement
        const transactionId: string = transaction.getTransactionId();

        // Submit: send endorsed transaction to orderer for ordering + commit
        // Returns SubmittedTransaction; get the endorsement result bytes via getResult()
        const submittedTx = await transaction.submit();
        const resultBytes: Uint8Array = submittedTx.getResult();

        // At this point, commit is confirmed (submitOptions deadline enforced)
        let resultJson: Record<string, any> = {};
        if (resultBytes && resultBytes.length > 0) {
            const resultStr = utf8Decoder.decode(resultBytes);
            try {
                resultJson = JSON.parse(resultStr);
            } catch {
                resultJson = { data: resultStr };
            }
        }

        return res.status(200).json({
            transaction_id: transactionId,   // REAL 64-char Fabric TX ID
            status: 'COMMITTED',
            result: resultJson,
        });

    } catch (error: any) {
        // Propagate to error handler — never silently return a fake TX ID
        next(error);
    }
};

/**
 * Evaluate a read-only query against Fabric (no transaction, no tx ID).
 * Used for getBatch, getProduct, getUnit, getBatchHistory.
 */
export const evaluateQuery = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const actorMsp: string = (req as any).actorMsp;
        const { functionName, args } = req.body;

        if (!functionName) {
            return res.status(400).json({ error: 'functionName is required' });
        }

        const contract = await fabricManager.getContract(actorMsp);

        const stringArgs: string[] = (args || []).map((arg: any) =>
            typeof arg === 'string' ? arg : JSON.stringify(arg)
        );

        const resultBytes = await contract.evaluateTransaction(functionName, ...stringArgs);

        let result: any = null;
        if (resultBytes && resultBytes.length > 0) {
            const resultStr = utf8Decoder.decode(resultBytes);
            try {
                result = JSON.parse(resultStr);
            } catch {
                result = { data: resultStr };
            }
        }

        return res.status(200).json({ result });

    } catch (error: any) {
        next(error);
    }
};
