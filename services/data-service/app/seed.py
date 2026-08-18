import asyncio
import uuid
import logging
from sqlalchemy.future import select

from app.database import AsyncSessionLocal
from app.models.identity import Organization, User

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("sih.seed")

# ============================================================
# Stable UUIDs for the five organizations
# ============================================================
ORG_REGULATORY_ID   = uuid.UUID("11111111-1111-1111-1111-111111111111")
ORG_PRODUCER_ID     = uuid.UUID("22222222-2222-2222-2222-222222222222")
ORG_MANUFACTURER_ID = uuid.UUID("33333333-3333-3333-3333-333333333333")
ORG_DELIVERER_ID    = uuid.UUID("44444444-4444-4444-4444-444444444444")
ORG_RETAILER_ID     = uuid.UUID("55555555-5555-5555-5555-555555555555")

# Stable UUIDs for demo users (one per org)
USER_REGULATOR_ID   = uuid.UUID("aaaaaaaa-1111-1111-1111-111111111111")
USER_PRODUCER_ID    = uuid.UUID("aaaaaaaa-2222-2222-2222-222222222222")
USER_MANUFACTURER_ID= uuid.UUID("aaaaaaaa-3333-3333-3333-333333333333")
USER_DELIVERER_ID   = uuid.UUID("aaaaaaaa-4444-4444-4444-444444444444")
USER_RETAILER_ID    = uuid.UUID("aaaaaaaa-5555-5555-5555-555555555555")

# System actor UUID — used by webhook handler for fabric events
SYSTEM_ORG_UUID  = uuid.UUID("00000000-0000-0000-0000-000000000000")
SYSTEM_USER_UUID = uuid.UUID("00000000-0000-0000-0000-000000000000")


DEMO_ORGS = [
    {
        "org_id": ORG_REGULATORY_ID,
        "name": "Regulatory Department",
        "type": "REGULATOR",
        "fabric_msp_id": "RegulatoryDepartmentMSP",
        "status": "ACTIVE",
    },
    {
        "org_id": ORG_PRODUCER_ID,
        "name": "GreenValley Farm (Producer)",
        "type": "PRODUCER",
        "fabric_msp_id": "ProducerMSP",
        "status": "ACTIVE",
    },
    {
        "org_id": ORG_MANUFACTURER_ID,
        "name": "FoodProcess Industries (Manufacturer)",
        "type": "MANUFACTURER",
        "fabric_msp_id": "ManufacturerMSP",
        "status": "ACTIVE",
    },
    {
        "org_id": ORG_DELIVERER_ID,
        "name": "QuickMove Logistics (Deliverer)",
        "type": "DELIVERER",
        "fabric_msp_id": "DelivererMSP",
        "status": "ACTIVE",
    },
    {
        "org_id": ORG_RETAILER_ID,
        "name": "FreshMart Retail (Retailer)",
        "type": "RETAILER",
        "fabric_msp_id": "RetailerMSP",
        "status": "ACTIVE",
    },
]

DEMO_USERS = [
    {
        "user_id": USER_REGULATOR_ID,
        "organization_id": ORG_REGULATORY_ID,
        "role_id": "regulator",
        "auth_subject": "usr-regulator",
        "status": "ACTIVE",
    },
    {
        "user_id": USER_PRODUCER_ID,
        "organization_id": ORG_PRODUCER_ID,
        "role_id": "producer",
        "auth_subject": "usr-producer",
        "status": "ACTIVE",
    },
    {
        "user_id": USER_MANUFACTURER_ID,
        "organization_id": ORG_MANUFACTURER_ID,
        "role_id": "manufacturer",
        "auth_subject": "usr-manufacturer",
        "status": "ACTIVE",
    },
    {
        "user_id": USER_DELIVERER_ID,
        "organization_id": ORG_DELIVERER_ID,
        "role_id": "deliverer",
        "auth_subject": "usr-deliverer",
        "status": "ACTIVE",
    },
    {
        "user_id": USER_RETAILER_ID,
        "organization_id": ORG_RETAILER_ID,
        "role_id": "retailer",
        "auth_subject": "usr-retailer",
        "status": "ACTIVE",
    },
]


async def seed_data():
    """
    Seeds the five-organization model into PostgreSQL.

    Organizations:
      11111111-... RegulatoryDepartmentMSP  (Regulatory Department)
      22222222-... ProducerMSP              (GreenValley Farm)
      33333333-... ManufacturerMSP          (FoodProcess Industries)
      44444444-... DelivererMSP             (QuickMove Logistics)
      55555555-... RetailerMSP              (FreshMart Retail)

    One User per Organization for demo authentication.
    """
    logger.info("Starting five-organization database seeding...")

    async with AsyncSessionLocal() as session:
        async with session.begin():
            # ── 1. Seed Organizations ──────────────────────────────────
            for org_data in DEMO_ORGS:
                existing = await session.execute(
                    select(Organization).where(Organization.org_id == org_data["org_id"])
                )
                if not existing.scalar_one_or_none():
                    org = Organization(**org_data)
                    session.add(org)
                    logger.info(f"  Seeded Org: {org_data['name']} ({org_data['fabric_msp_id']})")
                else:
                    logger.info(f"  Org exists: {org_data['name']} — skipping")

            # ── 2. Seed Demo Users ─────────────────────────────────────
            for user_data in DEMO_USERS:
                existing = await session.execute(
                    select(User).where(User.user_id == user_data["user_id"])
                )
                if not existing.scalar_one_or_none():
                    user = User(**user_data)
                    session.add(user)
                    logger.info(f"  Seeded User: {user_data['auth_subject']} ({user_data['role_id']})")
                else:
                    logger.info(f"  User exists: {user_data['auth_subject']} — skipping")

    logger.info("Database seeding complete.")
    logger.info("")
    logger.info("Demo login credentials (use in /api/v1/auth/login):")
    logger.info("  { username: 'usr-regulator',    role: 'regulator',    org_id: '11111111-...' }")
    logger.info("  { username: 'usr-producer',     role: 'producer',     org_id: '22222222-...' }")
    logger.info("  { username: 'usr-manufacturer', role: 'manufacturer', org_id: '33333333-...' }")
    logger.info("  { username: 'usr-deliverer',    role: 'deliverer',    org_id: '44444444-...' }")
    logger.info("  { username: 'usr-retailer',     role: 'retailer',     org_id: '55555555-...' }")


if __name__ == "__main__":
    asyncio.run(seed_data())
