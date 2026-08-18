from fastapi import APIRouter, Header, HTTPException, status, Depends
from typing import Dict, Any, Optional
import logging

from app.config import settings
from app.clients import get_data_client

logger = logging.getLogger("sih.webhooks")

router = APIRouter(prefix="/internal/webhooks", tags=["webhooks"])

# ============================================================
# Internal Auth
# ============================================================
def verify_webhook_token(authorization: str = Header(...)):
    if not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authorization header format"
        )
    token = authorization.split(" ")[1]
    if token != settings.INTERNAL_API_KEY:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid internal API key"
        )
    return token


# ============================================================
# Payload Normalizer: Chaincode emits camelCase keys.
# D1 / application uses snake_case. Normalize here.
# ============================================================
def _normalize_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    Normalize camelCase chaincode event payload keys to snake_case.
    Only the commonly used fields are mapped — extra fields pass through unchanged.
    """
    key_map = {
        "batchId":       "batch_id",
        "productId":     "product_id",
        "unitId":        "unit_id",
        "incidentId":    "incident_id",
        "currentCustodian": "current_custodian",
        "currentState":  "state",
        "pendingCustodian": "pending_custodian",
        "fromOrg":       "from_org",
        "toOrg":         "to_org",
        "childBatchId":  "child_batch_id",
        "parentBatchIds": "parent_batch_ids",
        "newProductId":  "new_product_id",
        "createdBy":     "created_by",
        "submittingMsp": "submitting_msp",
    }
    normalized: Dict[str, Any] = {}
    for k, v in payload.items():
        normalized_key = key_map.get(k, k)
        normalized[normalized_key] = v
    return normalized


def _extract_target_id(event_name: str, payload: Dict[str, Any]) -> Optional[str]:
    """
    Derive the primary entity ID from the event payload.
    Priority order: batch_id > unit_id > product_id > incident_id
    """
    return (
        payload.get("batch_id")
        or payload.get("child_batch_id")
        or payload.get("unit_id")
        or payload.get("product_id")
        or payload.get("incident_id")
    )


# ============================================================
# Fabric Webhook Handler
# ============================================================
@router.post("/fabric")
async def receive_fabric_event(
    payload: Dict[str, Any],
    token: str = Depends(verify_webhook_token)
):
    """
    Receives Fabric chaincode events from the D2 Blockchain Gateway.

    Expected payload from eventListener.ts:
    {
        "transaction_id": "<real fabric tx id>",
        "block_number": 12,
        "channel_id": "tracechannel",
        "chaincode_id": "traceability",
        "event_name": "BATCH_REGISTERED",
        "payload": { ... chaincode event envelope ... },
        "emitted_at": "2026-08-18T..."
    }

    Idempotency: D1 enforces UNIQUE constraint on fabric_tx_id.
    A 409 Conflict from D1 means duplicate — we return HTTP 200 so
    the Gateway does NOT retry an already-processed event.
    """
    event_name: str = payload.get("event_name", "UNKNOWN")
    transaction_id: str = payload.get("transaction_id", "")
    block_number: Optional[int] = payload.get("block_number")
    channel_id: str = payload.get("channel_id", "tracechannel")
    emitted_at = payload.get("emitted_at")

    # Get and normalize the inner chaincode event payload
    raw_payload: Dict[str, Any] = payload.get("payload") or {}
    cc_payload = _normalize_payload(raw_payload)

    logger.info(f"[webhook] {event_name} | tx={transaction_id} | block={block_number}")

    if not transaction_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="transaction_id is missing from webhook payload"
        )

    target_id = _extract_target_id(event_name, cc_payload)
    if not target_id:
        logger.warning(
            f"[webhook] Cannot derive target_id from {event_name} payload: {cc_payload}"
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot derive target_id from event {event_name}. "
                   f"Payload keys: {list(cc_payload.keys())}"
        )

    data_client = get_data_client()

    # ──────────────────────────────────────────────────────
    # Map event type → state for D1 event record
    # ──────────────────────────────────────────────────────
    EVENT_STATE_MAP = {
        "PRODUCT_REGISTERED": ("PRODUCT", "ACTIVE"),
        "PRODUCT_BLOCKED":    ("PRODUCT", "BLOCKED"),
        "PRODUCT_UNBLOCKED":  ("PRODUCT", "ACTIVE"),
        "BATCH_REGISTERED":   ("BATCH", "REGISTERED"),
        "BATCH_VALIDATED":    ("BATCH", cc_payload.get("state", "VALIDATED")),
        "BATCH_TRANSFERRED":  ("BATCH", "IN_TRANSIT"),
        "BATCH_RECEIVED":     ("BATCH", "RECEIVED"),
        "BATCH_PROCESSED":    ("BATCH", "PROCESSED"),
        "BATCH_AVAILABLE":    ("BATCH", "AVAILABLE"),
        "BATCH_BLOCKED":      ("BATCH", "BLOCKED"),
        "BATCH_UNBLOCKED":    ("BATCH", "VALIDATED"),
        "BATCH_TRANSFORMED":  ("BATCH", "PROCESSED"),
        "TRANSFORMATION_CREATED": ("BATCH", "PROCESSED"),
        "UNIT_CREATED":       ("UNIT", cc_payload.get("state", "AVAILABLE")),
        "RECALL_CREATED":     ("BATCH", "RECALLED"),
    }

    entity_type, state_after = EVENT_STATE_MAP.get(event_name, ("UNKNOWN", None))

    # System actor UUIDs (webhook events have no user context)
    SYSTEM_UUID = "00000000-0000-0000-0000-000000000000"

    # Extra metadata to store alongside the event (everything not core)
    core_keys = {
        "batch_id", "product_id", "unit_id", "child_batch_id",
        "state", "event_type", "transaction_id", "emitted_at",
        "submitting_msp", "latitude", "longitude", "location_name"
    }
    metadata_extras = {k: v for k, v in cc_payload.items() if k not in core_keys}

    mapped_event = {
        "type": event_name,
        "actor_org_id": SYSTEM_UUID,
        "actor_user_id": SYSTEM_UUID,
        "target_id": target_id,
        "state_before": None,
        "state_after": state_after,
        "fabric_tx_id": transaction_id,
        "timestamp": emitted_at,
        "latitude": cc_payload.get("latitude"),
        "longitude": cc_payload.get("longitude"),
        "location_name": cc_payload.get("location_name"),
        "block_number": block_number,
        "metadata": {
            **metadata_extras,
            "channel_id": channel_id,
            "actor_msp": cc_payload.get("submitting_msp"),
            "entity_type": entity_type,
        },
    }

    try:
        await data_client.save_event(mapped_event)
        logger.info(f"[webhook] ✓ Event {event_name} saved (tx={transaction_id[:16]}...)")

    except Exception as e:
        # ── Idempotency: D1 returns 409 if fabric_tx_id already exists ──
        is_http_error = hasattr(e, "response")
        if is_http_error and e.response.status_code == 409:  # type: ignore
            logger.info(
                f"[webhook] Duplicate event {event_name} (tx={transaction_id[:16]}...) — ignored"
            )
            return {"status": "success", "message": "Duplicate event ignored (idempotent)"}

        logger.error(f"[webhook] Failed to save event {event_name}: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to forward event to data service: {str(e)}"
        )

    return {
        "status": "success",
        "message": f"Event {event_name} processed",
        "transaction_id": transaction_id,
        "target_id": target_id,
    }
