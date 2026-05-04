import pg from "pg";
import crypto from "node:crypto";

const E2E_PREFIX = "e2e-test-";

function e2eId(prefix: string): string {
  return `${prefix}_${E2E_PREFIX}${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export interface SeedResult {
  orgId: string;
  cycleId: string;
  opportunityId: string;
  userId: string;
  userRoleId: string;
}

let _pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!_pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is required for E2E seed");
    _pool = new pg.Pool({ connectionString: url, max: 3 });
  }
  return _pool;
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

export async function seedApproveOpportunity(): Promise<SeedResult> {
  const pool = getPool();

  const orgId = e2eId("org");
  const cycleId = e2eId("cyc");
  const opportunityId = e2eId("opp");
  const userId = `user_${E2E_PREFIX}approver`;
  const userRoleId = e2eId("ur");
  const stageHistoryId = e2eId("sh");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO orgs (id, name, slug, created_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (id) DO NOTHING`,
      [orgId, "E2E Test Org", `e2e-test-${Date.now()}`],
    );

    await client.query(
      `INSERT INTO analysis_cycles (id, org_id, generation, status, triggered_by, started_at, completed_at)
       VALUES ($1, $2, 1, 'completed', 'e2e-seed', NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [cycleId, orgId],
    );

    await client.query(
      `INSERT INTO opportunities (
         id, org_id, cycle_id, lever_id, tier, title, rationale,
         recommended_action, raw_projected_savings_usd, projected_savings_usd,
         confidence, status, inputs,
         canonical_stage, savings_type, stage_entered_at, doa_tier, created_at
       ) VALUES (
         $1, $2, $3, 'sku_price_benchmark', 1,
         'E2E Test: Approve Journey Opportunity',
         'Automated E2E test opportunity for the approve journey.',
         'Approve this opportunity to validate the E2E test.',
         '500000.00', '500000.00', '0.8500', 'proposed',
         '{}',
         'Identified', 'Identified', NOW(), 2, NOW()
       )`,
      [opportunityId, orgId, cycleId],
    );

    await client.query(
      `INSERT INTO opportunity_stage_history (
         id, opportunity_id, org_id, from_stage, to_stage,
         transitioned_at, transitioned_by_user_id, transition_reason
       ) VALUES ($1, $2, $3, NULL, 'Identified', NOW(), NULL, 'BACKFILL')`,
      [stageHistoryId, opportunityId, orgId],
    );

    await client.query(
      `INSERT INTO user_roles (id, user_id, org_id, role, email, granted_via, granted_by, created_at)
       VALUES ($1, $2, $3, 'approver', 'e2e-approver@test.local', 'manual', 'e2e-seed', NOW())
       ON CONFLICT DO NOTHING`,
      [userRoleId, userId, orgId],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return { orgId, cycleId, opportunityId, userId, userRoleId };
}

export async function seedRejectOpportunity(): Promise<SeedResult> {
  const pool = getPool();

  const orgId = e2eId("org");
  const cycleId = e2eId("cyc");
  const opportunityId = e2eId("opp");
  const userId = `user_${E2E_PREFIX}approver`;
  const userRoleId = e2eId("ur");
  const stageHistoryId = e2eId("sh");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO orgs (id, name, slug, created_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (id) DO NOTHING`,
      [orgId, "E2E Test Org (Reject)", `e2e-test-reject-${Date.now()}`],
    );

    await client.query(
      `INSERT INTO analysis_cycles (id, org_id, generation, status, triggered_by, started_at, completed_at)
       VALUES ($1, $2, 1, 'completed', 'e2e-seed', NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [cycleId, orgId],
    );

    await client.query(
      `INSERT INTO opportunities (
         id, org_id, cycle_id, lever_id, tier, title, rationale,
         recommended_action, raw_projected_savings_usd, projected_savings_usd,
         confidence, status, inputs,
         canonical_stage, savings_type, stage_entered_at, doa_tier, created_at
       ) VALUES (
         $1, $2, $3, 'sku_price_benchmark', 1,
         'E2E Test: Reject Journey Opportunity',
         'Automated E2E test opportunity for the reject journey.',
         'Reject this opportunity to validate the E2E test.',
         '250000.00', '250000.00', '0.6000', 'proposed',
         '{}',
         'Identified', 'Identified', NOW(), 3, NOW()
       )`,
      [opportunityId, orgId, cycleId],
    );

    await client.query(
      `INSERT INTO opportunity_stage_history (
         id, opportunity_id, org_id, from_stage, to_stage,
         transitioned_at, transitioned_by_user_id, transition_reason
       ) VALUES ($1, $2, $3, NULL, 'Identified', NOW(), NULL, 'BACKFILL')`,
      [stageHistoryId, opportunityId, orgId],
    );

    await client.query(
      `INSERT INTO user_roles (id, user_id, org_id, role, email, granted_via, granted_by, created_at)
       VALUES ($1, $2, $3, 'approver', 'e2e-approver@test.local', 'manual', 'e2e-seed', NOW())
       ON CONFLICT DO NOTHING`,
      [userRoleId, userId, orgId],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return { orgId, cycleId, opportunityId, userId, userRoleId };
}

export async function cleanup(seed: SeedResult): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM decisions WHERE org_id = $1`, [seed.orgId]);
    await client.query(`DELETE FROM opportunity_stage_history WHERE org_id = $1`, [seed.orgId]);
    await client.query(`DELETE FROM opportunities WHERE org_id = $1`, [seed.orgId]);
    await client.query(`DELETE FROM analysis_cycles WHERE org_id = $1`, [seed.orgId]);
    await client.query(`DELETE FROM user_roles WHERE org_id = $1`, [seed.orgId]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
