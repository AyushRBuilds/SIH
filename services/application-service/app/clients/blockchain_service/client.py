from typing import Any, Dict, List, Optional
import httpx
import uuid
from app.config import settings


class BlockchainServiceClient:
    """
    Client for communicating with the D2 Blockchain Gateway Service.

    All state-changing methods (submit) return a real Fabric transaction ID.
    All read-only methods (evaluate) return Fabric ledger state — no tx ID.
    """

    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")
        self._timeout = httpx.Timeout(60.0, connect=10.0)

    def _get_headers(self, actor_context: Dict[str, Any]) -> Dict[str, str]:
        fabric_msp_id = actor_context.get("fabric_msp_id")
        if not fabric_msp_id:
            raise ValueError(
                "fabric_msp_id is missing from actor_context. "
                "Ensure the authenticated user has a valid Fabric MSP identity."
            )
        return {
            "Authorization": f"Bearer {settings.INTERNAL_API_KEY}",
            "X-Actor-MSP": fabric_msp_id,
            "X-Idempotency-Key": str(uuid.uuid4()),
            "Content-Type": "application/json",
        }

    def _get_query_headers(self, actor_context: Dict[str, Any]) -> Dict[str, str]:
        """Headers for read-only evaluate calls (no idempotency key required)."""
        fabric_msp_id = actor_context.get("fabric_msp_id")
        if not fabric_msp_id:
            raise ValueError("fabric_msp_id is missing from actor_context")
        return {
            "Authorization": f"Bearer {settings.INTERNAL_API_KEY}",
            "X-Actor-MSP": fabric_msp_id,
            "Content-Type": "application/json",
        }

    def _assert_committed(self, data: Dict[str, Any]) -> None:
        if data.get("status") != "COMMITTED":
            raise RuntimeError(
                f"Blockchain transaction was not committed. Response: {data}"
            )

    # ============================================================
    # PRODUCT TRANSACTIONS
    # ============================================================

    async def register_product(
        self,
        product_id: str,
        name: str,
        product_type: str,
        actor_context: Dict[str, Any]
    ) -> Dict[str, Any]:
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            res = await client.post(
                f"{self.base_url}/internal/transactions/products",
                json={"productId": product_id, "name": name, "productType": product_type},
                headers=self._get_headers(actor_context)
            )
            res.raise_for_status()
            data = res.json()
            self._assert_committed(data)
            return data

    async def block_product(
        self,
        product_id: str,
        reason: str,
        actor_context: Dict[str, Any]
    ) -> Dict[str, Any]:
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            res = await client.post(
                f"{self.base_url}/internal/transactions/products/{product_id}/block",
                json={"productId": product_id, "reason": reason},
                headers=self._get_headers(actor_context)
            )
            res.raise_for_status()
            data = res.json()
            self._assert_committed(data)
            return data

    async def unblock_product(
        self,
        product_id: str,
        reason: str,
        actor_context: Dict[str, Any]
    ) -> Dict[str, Any]:
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            res = await client.post(
                f"{self.base_url}/internal/transactions/products/{product_id}/unblock",
                json={"productId": product_id, "reason": reason},
                headers=self._get_headers(actor_context)
            )
            res.raise_for_status()
            data = res.json()
            self._assert_committed(data)
            return data

    # ============================================================
    # BATCH TRANSACTIONS
    # ============================================================

    async def register_batch(
        self,
        batch_id: str,
        product_id: str,
        quantity: float,
        unit_of_measure: str,
        actor_context: Dict[str, Any],
        metadataJson: str = ""
    ) -> Dict[str, Any]:
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            res = await client.post(
                f"{self.base_url}/internal/transactions/batches",
                json={
                    "batchId": batch_id,
                    "productId": product_id,
                    "quantity": str(quantity),
                    "metadataJson": metadataJson
                },
                headers=self._get_headers(actor_context)
            )
            res.raise_for_status()
            data = res.json()
            self._assert_committed(data)
            return data

    async def validate_batch(
        self,
        batch_id: str,
        actor_context: Dict[str, Any],
        validation_result: str = "VALID",
        metadataJson: str = ""
    ) -> Dict[str, Any]:
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            res = await client.post(
                f"{self.base_url}/internal/transactions/batches/{batch_id}/validate",
                json={
                    "batchId": batch_id,
                    "validationResult": validation_result,
                    "metadataJson": metadataJson
                },
                headers=self._get_headers(actor_context)
            )
            res.raise_for_status()
            data = res.json()
            self._assert_committed(data)
            return data

    async def transfer_batch(
        self,
        batch_id: str,
        to_org_msp: str,
        actor_context: Dict[str, Any],
        metadataJson: str = ""
    ) -> Dict[str, Any]:
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            res = await client.post(
                f"{self.base_url}/internal/transactions/transfer",
                json={
                    "batchId": batch_id,
                    "targetOrg": to_org_msp,
                    "metadataJson": metadataJson
                },
                headers=self._get_headers(actor_context)
            )
            res.raise_for_status()
            data = res.json()
            self._assert_committed(data)
            return data

    async def receive_batch(
        self,
        batch_id: str,
        actor_context: Dict[str, Any],
        metadataJson: str = ""
    ) -> Dict[str, Any]:
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            res = await client.post(
                f"{self.base_url}/internal/transactions/receive",
                json={"batchId": batch_id, "metadataJson": metadataJson},
                headers=self._get_headers(actor_context)
            )
            res.raise_for_status()
            data = res.json()
            self._assert_committed(data)
            return data

    async def process_batch(
        self,
        batch_id: str,
        actor_context: Dict[str, Any],
        metadataJson: str = ""
    ) -> Dict[str, Any]:
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            res = await client.post(
                f"{self.base_url}/internal/transactions/batches/{batch_id}/process",
                json={"batchId": batch_id, "metadataJson": metadataJson},
                headers=self._get_headers(actor_context)
            )
            res.raise_for_status()
            data = res.json()
            self._assert_committed(data)
            return data

    async def make_available(
        self,
        batch_id: str,
        actor_context: Dict[str, Any],
        metadataJson: str = ""
    ) -> Dict[str, Any]:
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            res = await client.post(
                f"{self.base_url}/internal/transactions/batches/{batch_id}/make-available",
                json={"batchId": batch_id, "metadataJson": metadataJson},
                headers=self._get_headers(actor_context)
            )
            res.raise_for_status()
            data = res.json()
            self._assert_committed(data)
            return data

    async def block_batch(
        self,
        batch_id: str,
        reason: str,
        actor_context: Dict[str, Any]
    ) -> Dict[str, Any]:
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            res = await client.post(
                f"{self.base_url}/internal/transactions/batches/{batch_id}/block",
                json={"batchId": batch_id, "reason": reason},
                headers=self._get_headers(actor_context)
            )
            res.raise_for_status()
            data = res.json()
            self._assert_committed(data)
            return data

    async def unblock_batch(
        self,
        batch_id: str,
        reason: str,
        actor_context: Dict[str, Any]
    ) -> Dict[str, Any]:
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            res = await client.post(
                f"{self.base_url}/internal/transactions/batches/{batch_id}/unblock",
                json={"batchId": batch_id, "reason": reason},
                headers=self._get_headers(actor_context)
            )
            res.raise_for_status()
            data = res.json()
            self._assert_committed(data)
            return data

    async def recall_batch(
        self,
        batch_id: str,
        reason: str,
        actor_context: Dict[str, Any]
    ) -> Dict[str, Any]:
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            res = await client.post(
                f"{self.base_url}/internal/transactions/batches/{batch_id}/recall",
                json={"batchId": batch_id, "reason": reason},
                headers=self._get_headers(actor_context)
            )
            res.raise_for_status()
            data = res.json()
            self._assert_committed(data)
            return data

    async def create_transformation(
        self,
        parent_batch_ids: List[str],
        child_batch_id: str,
        new_product_id: str,
        actor_context: Dict[str, Any],
        metadataJson: str = ""
    ) -> Dict[str, Any]:
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            res = await client.post(
                f"{self.base_url}/internal/transactions/transform",
                json={
                    "parentBatchIds": parent_batch_ids,
                    "childBatchId": child_batch_id,
                    "newProductId": new_product_id,
                    "metadataJson": metadataJson
                },
                headers=self._get_headers(actor_context)
            )
            res.raise_for_status()
            data = res.json()
            self._assert_committed(data)
            return data

    async def create_unit(
        self,
        batch_id: str,
        unit_id: str,
        actor_context: Dict[str, Any]
    ) -> Dict[str, Any]:
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            res = await client.post(
                f"{self.base_url}/internal/transactions/units",
                json={"batchId": batch_id, "unitId": unit_id},
                headers=self._get_headers(actor_context)
            )
            res.raise_for_status()
            data = res.json()
            self._assert_committed(data)
            return data

    # ============================================================
    # READ-ONLY FABRIC QUERIES (no transaction — evaluate only)
    # ============================================================

    async def get_product_from_fabric(
        self,
        product_id: str,
        actor_context: Dict[str, Any]
    ) -> Optional[Dict[str, Any]]:
        """Query Fabric ledger for a product. Returns None if not found."""
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            res = await client.get(
                f"{self.base_url}/internal/transactions/products/{product_id}",
                headers=self._get_query_headers(actor_context)
            )
            if res.status_code == 404:
                return None
            res.raise_for_status()
            return res.json().get("result")

    async def get_batch_from_fabric(
        self,
        batch_id: str,
        actor_context: Dict[str, Any]
    ) -> Optional[Dict[str, Any]]:
        """Query Fabric ledger for a batch. Returns None if not found."""
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            res = await client.get(
                f"{self.base_url}/internal/transactions/batches/{batch_id}",
                headers=self._get_query_headers(actor_context)
            )
            if res.status_code == 404:
                return None
            res.raise_for_status()
            return res.json().get("result")

    async def get_batch_history(
        self,
        batch_id: str,
        actor_context: Dict[str, Any]
    ) -> List[Dict[str, Any]]:
        """Query full batch key history from Fabric ledger."""
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            res = await client.get(
                f"{self.base_url}/internal/transactions/batches/{batch_id}/history",
                headers=self._get_query_headers(actor_context)
            )
            res.raise_for_status()
            return res.json().get("result") or []

    async def get_unit_from_fabric(
        self,
        unit_id: str,
        actor_context: Dict[str, Any]
    ) -> Optional[Dict[str, Any]]:
        """Query Fabric ledger for a unit. Returns None if not found."""
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            res = await client.get(
                f"{self.base_url}/internal/transactions/units/{unit_id}",
                headers=self._get_query_headers(actor_context)
            )
            if res.status_code == 404:
                return None
            res.raise_for_status()
            return res.json().get("result")

    async def verify_unit_on_fabric(
        self,
        unit_id: str,
        actor_context: Dict[str, Any]
    ) -> Optional[Dict[str, Any]]:
        """Call verifyUnit chaincode function — returns unit + batch + product state."""
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            res = await client.get(
                f"{self.base_url}/internal/transactions/units/{unit_id}/verify",
                headers=self._get_query_headers(actor_context)
            )
            if res.status_code == 404:
                return None
            res.raise_for_status()
            return res.json().get("result")
