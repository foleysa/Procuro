/**
 * One-command database seed for tests and local dev.
 *
 * Run with: `pnpm --filter @workspace/scripts run seed`
 *
 * What this guarantees
 * --------------------
 * After `pnpm --filter @workspace/db run push` + this script, the database
 * holds at least one row in `orgs`. That is the minimum required by the
 * integration tests in `artifacts/api-server/test/` (each one calls
 * `pickOrgId()` which reads the first org).
 *
 * Idempotency
 * -----------
 * Every insert uses `ON CONFLICT DO NOTHING` against either the primary key
 * or a unique constraint, so running the script repeatedly is safe and
 * never duplicates rows. It also never wipes existing data — if a developer
 * already has richer data in their local database, this script tops it up
 * without destroying it.
 *
 * Optional demo blocks
 * --------------------
 * `seedFxExposureDemo()` adds two non-USD-billing suppliers and a tiny
 * `fx_rate` market-signal window so the `supplier_fx_exposure` lever fires
 * on a freshly-pushed DB without waiting for the ECB collector to run.
 */
import {
  db,
  pool,
  orgsTable,
  suppliersTable,
  invoicesTable,
  collectorsTable,
  marketSignalsTable,
  statementsOfWorkTable,
  sowMilestonesTable,
  sowChangeOrdersTable,
  rateCardsTable,
  rateCardLinesTable,
  timeEntriesTable,
  type ContractType,
  type SowMilestoneStatus,
} from "@workspace/db";
import { sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SEED_ORG = {
  id: "org_seed_default",
  slug: "seed-default",
  name: "Seed Default Org",
} as const;

async function seedOrgs(): Promise<void> {
  // `id` is the primary key and `slug` is unique, so either constraint
  // would catch a re-run. `onConflictDoNothing` (no target) covers both.
  const inserted = await db
    .insert(orgsTable)
    .values({
      id: SEED_ORG.id,
      slug: SEED_ORG.slug,
      name: SEED_ORG.name,
    })
    .onConflictDoNothing()
    .returning({ id: orgsTable.id });

  if (inserted.length > 0) {
    console.log(`[seed] inserted org ${SEED_ORG.id} (${SEED_ORG.slug})`);
  } else {
    console.log(`[seed] org ${SEED_ORG.id} already present — no changes`);
  }
}

/**
 * Adds the minimum data needed to demo the `supplier_fx_exposure` lever
 * end-to-end without waiting on a live ECB collector run.
 *
 * Inserts:
 *   - two suppliers on `org_seed_default` billing in EUR and JPY
 *   - a synthetic `seed-fx-demo` collector
 *   - two `fx_rate` market-signal observations (start and end of the 30-day
 *     window) for `USD/EUR` and `USD/JPY`, with USD/EUR moving ~5% (above the
 *     3% threshold) and USD/JPY moving ~1% (below it)
 *
 * Idempotent: every row uses ON CONFLICT DO NOTHING against the natural key.
 */
async function seedFxExposureDemo(): Promise<void> {
  const orgId = SEED_ORG.id;
  const SOURCE = "seed-fx-demo";

  // 1. Suppliers — keyed by (org, source_system, source_external_id).
  await db
    .insert(suppliersTable)
    .values([
      {
        id: "sup_seed_fx_eur",
        orgId,
        name: "Berlin Components GmbH",
        normalizedName: "berlin components gmbh",
        countryCode: "DE",
        billingCurrency: "EUR",
        sourceSystem: SOURCE,
        sourceExternalId: "fx-demo-eur",
      },
      {
        id: "sup_seed_fx_jpy",
        orgId,
        name: "Osaka Precision KK",
        normalizedName: "osaka precision kk",
        countryCode: "JP",
        billingCurrency: "JPY",
        sourceSystem: SOURCE,
        sourceExternalId: "fx-demo-jpy",
      },
    ])
    .onConflictDoNothing();

  // 2. Invoices — give each non-USD supplier a known 12-month spend so the
  //    fx-exposure analyzer has a non-zero exposure to compute against.
  const recent = new Date();
  recent.setDate(recent.getDate() - 30);
  await db
    .insert(invoicesTable)
    .values([
      {
        id: "inv_seed_fx_eur",
        orgId,
        supplierId: "sup_seed_fx_eur",
        invoiceNumber: "SEED-FX-EUR-001",
        invoiceDate: recent,
        amountUsd: "250000.00",
        dedupKey: "seed-fx-eur-001",
        sourceSystem: SOURCE,
        sourceExternalId: "fx-demo-inv-eur",
      },
      {
        id: "inv_seed_fx_jpy",
        orgId,
        supplierId: "sup_seed_fx_jpy",
        invoiceNumber: "SEED-FX-JPY-001",
        invoiceDate: recent,
        amountUsd: "180000.00",
        dedupKey: "seed-fx-jpy-001",
        sourceSystem: SOURCE,
        sourceExternalId: "fx-demo-inv-jpy",
      },
    ])
    .onConflictDoNothing();

  // 3. Collector row to satisfy the FK on market_signals.collector_id.
  await db
    .insert(collectorsTable)
    .values({
      id: SOURCE,
      name: "FX Exposure Demo Seeder",
      description:
        "Synthetic collector used by scripts/src/seed.ts to plant fx_rate signals so the supplier_fx_exposure lever fires on a fresh DB.",
      posture: "public-api",
      status: "approved",
      owner: "seed-script",
      sourceUrl: "https://example.invalid/seed",
    })
    .onConflictDoNothing();

  // 4. fx_rate signals: two observations per pair to define a window.
  const now = new Date();
  const earlier = new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000);
  await db
    .insert(marketSignalsTable)
    .values([
      // USD/EUR moved 0.92 → 0.966 (~5% appreciation of USD vs EUR).
      {
        id: "msig_seed_fx_usdeur_old",
        orgId: null,
        collectorId: SOURCE,
        signalType: "fx_rate",
        scopeMaterialCode: "USD/EUR",
        value: "0.920000",
        unit: "USD/EUR",
        currency: "EUR",
        observedAt: earlier,
        sourceUrl: "https://example.invalid/seed",
        posture: "public-api",
        confidence: "0.9500",
        metadata: { base: "USD", quote: "EUR", seeded: true },
      },
      {
        id: "msig_seed_fx_usdeur_new",
        orgId: null,
        collectorId: SOURCE,
        signalType: "fx_rate",
        scopeMaterialCode: "USD/EUR",
        value: "0.966000",
        unit: "USD/EUR",
        currency: "EUR",
        observedAt: now,
        sourceUrl: "https://example.invalid/seed",
        posture: "public-api",
        confidence: "0.9500",
        metadata: { base: "USD", quote: "EUR", seeded: true },
      },
      // USD/JPY moved 150 → 151.5 (~1% — below threshold, should NOT fire).
      {
        id: "msig_seed_fx_usdjpy_old",
        orgId: null,
        collectorId: SOURCE,
        signalType: "fx_rate",
        scopeMaterialCode: "USD/JPY",
        value: "150.000000",
        unit: "USD/JPY",
        currency: "JPY",
        observedAt: earlier,
        sourceUrl: "https://example.invalid/seed",
        posture: "public-api",
        confidence: "0.9500",
        metadata: { base: "USD", quote: "JPY", seeded: true },
      },
      {
        id: "msig_seed_fx_usdjpy_new",
        orgId: null,
        collectorId: SOURCE,
        signalType: "fx_rate",
        scopeMaterialCode: "USD/JPY",
        value: "151.500000",
        unit: "USD/JPY",
        currency: "JPY",
        observedAt: now,
        sourceUrl: "https://example.invalid/seed",
        posture: "public-api",
        confidence: "0.9500",
        metadata: { base: "USD", quote: "JPY", seeded: true },
      },
    ])
    .onConflictDoUpdate({
      target: marketSignalsTable.id,
      // Refresh observedAt on every seed run so the demo opportunity
      // never ages out of the analyzer's 30-day lookback window.
      set: {
        observedAt: sql`excluded.observed_at`,
        value: sql`excluded.value`,
      },
    });

  console.log(
    `[seed] supplier_fx_exposure demo data ensured on ${orgId} (collector=${SOURCE}, fx observedAt refreshed)`,
  );
}

/**
 * Apply the bands routing taxonomy seed (`lib/db/seeds/taxonomy.sql`).
 *
 * The SQL file is the single source of truth for category/lever bands +
 * the global synonym registry. It is fully idempotent (every INSERT
 * uses `ON CONFLICT DO NOTHING`), so re-running it is a no-op once the
 * rows already exist. We resolve the path relative to this script
 * rather than `process.cwd()` so the seed works whether invoked from
 * the workspace root or the `scripts/` package directory.
 */
async function seedTaxonomyBands(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist path: scripts/dist/seed.js → ../../lib/db/seeds/taxonomy.sql
  // src path:  scripts/src/seed.ts  → ../../lib/db/seeds/taxonomy.sql
  const sqlPath = resolve(here, "..", "..", "lib", "db", "seeds", "taxonomy.sql");
  const seedSql = readFileSync(sqlPath, "utf8");
  await pool.query(seedSql);
  console.log(`[seed] taxonomy bands + synonym registry ensured`);
}

/**
 * Seed a representative set of SOWs and rate cards under any org that
 * already has services-class contracts. This is the data backbone for
 * the Services workspace (`/services`, `/sows/:id`, `/rate-cards/:id`)
 * shipped in Task #217 — without it, those pages render empty states.
 *
 * For each qualifying org we:
 *   1. Pick the first 5 services-class contracts (ordered by
 *      contract_number for determinism) and stamp each with a distinct
 *      services contract_type so they become MSAs spanning the full
 *      enum (t_and_m, fixed_price, milestone, retainer, outcome).
 *   2. Insert one SOW under each MSA, with a few milestones in mixed
 *      states (some accepted/invoiced so `earnedUsd` is non-zero) and
 *      at least one change order so the SOW detail page has data.
 *   3. Insert 5 rate cards on the same five suppliers — three active,
 *      one expired (effective/expiry dates in the past), one active
 *      with a small batch of off-card time entries (rate_card_line_id
 *      NULL) so the leakage panel on the rate-card detail page is
 *      non-empty. Each card carries a handful of role/seniority lines.
 *
 * Idempotency: every insert keys on the unique constraint
 * `(orgId, sourceSystem, sourceExternalId)` (or the equivalent natural
 * key) with `ON CONFLICT DO NOTHING`. The contract_type stamp uses an
 * UPDATE that only writes when the row is still `goods`, so re-runs are
 * no-ops once the demo dataset is in place.
 */
const SVC_DEMO_SOURCE = "seed-services-demo";

const SOW_TEMPLATES: Array<{
  contractType: ContractType;
  titleSuffix: string;
  scope: string;
  totalValueUsd: number;
  milestones: Array<{
    title: string;
    valueUsd: number;
    status: SowMilestoneStatus;
    /** Days from `startDate` for due_date. */
    dueOffsetDays: number;
  }>;
  changeOrder: {
    title: string;
    description: string;
    valueDeltaUsd: number;
    dateDeltaDays: number;
    approver: string;
  } | null;
}> = [
  {
    contractType: "t_and_m",
    titleSuffix: "Q4 Engineering Augmentation",
    scope: "Front-end + platform engineering augmentation, 6 FTE",
    totalValueUsd: 480000,
    milestones: [
      { title: "Discovery & onboarding", valueUsd: 60000, status: "accepted", dueOffsetDays: 30 },
      { title: "Sprint 1-3 delivery", valueUsd: 180000, status: "invoiced", dueOffsetDays: 90 },
      { title: "Sprint 4-6 delivery", valueUsd: 180000, status: "in_progress", dueOffsetDays: 150 },
      { title: "Knowledge transfer & wrap-up", valueUsd: 60000, status: "pending", dueOffsetDays: 180 },
    ],
    changeOrder: {
      title: "Add 1 senior backend engineer",
      description: "Add one senior backend engineer through end of engagement.",
      valueDeltaUsd: 80000,
      dateDeltaDays: 0,
      approver: "alex.lee@example.com",
    },
  },
  {
    contractType: "fixed_price",
    titleSuffix: "ERP Phase 1 Implementation",
    scope: "Design and rollout of Coupa P2P module across 3 BUs.",
    totalValueUsd: 750000,
    milestones: [
      { title: "Blueprint sign-off", valueUsd: 150000, status: "accepted", dueOffsetDays: 45 },
      { title: "Build complete", valueUsd: 300000, status: "delivered", dueOffsetDays: 120 },
      { title: "UAT pass", valueUsd: 150000, status: "in_progress", dueOffsetDays: 180 },
      { title: "Hyper-care exit", valueUsd: 150000, status: "pending", dueOffsetDays: 240 },
    ],
    changeOrder: null,
  },
  {
    contractType: "milestone",
    titleSuffix: "Data Platform Migration",
    scope: "Migrate legacy Hadoop estate to Snowflake; 3 milestones.",
    totalValueUsd: 1200000,
    milestones: [
      { title: "Source-system inventory", valueUsd: 200000, status: "paid", dueOffsetDays: 60 },
      { title: "Tier-1 dataset migration", valueUsd: 500000, status: "invoiced", dueOffsetDays: 180 },
      { title: "Tier-2 dataset migration", valueUsd: 350000, status: "in_progress", dueOffsetDays: 270 },
      { title: "Decommission legacy cluster", valueUsd: 150000, status: "pending", dueOffsetDays: 330 },
    ],
    changeOrder: {
      title: "Defer Tier-2 migration by 30 days",
      description: "Tier-2 datasets blocked on upstream schema cleanup.",
      valueDeltaUsd: 0,
      dateDeltaDays: 30,
      approver: "morgan.chen@example.com",
    },
  },
  {
    contractType: "retainer",
    titleSuffix: "Managed Security Services Retainer",
    scope: "24x7 SOC monitoring + monthly threat hunt.",
    totalValueUsd: 360000,
    milestones: [
      { title: "Onboarding & playbooks", valueUsd: 30000, status: "accepted", dueOffsetDays: 30 },
      { title: "Q1 retainer", valueUsd: 90000, status: "invoiced", dueOffsetDays: 90 },
      { title: "Q2 retainer", valueUsd: 90000, status: "in_progress", dueOffsetDays: 180 },
      { title: "Q3 retainer", valueUsd: 90000, status: "pending", dueOffsetDays: 270 },
      { title: "Q4 retainer", valueUsd: 60000, status: "pending", dueOffsetDays: 360 },
    ],
    changeOrder: null,
  },
  {
    contractType: "outcome",
    titleSuffix: "Cost Recovery Audit Engagement",
    scope: "Contingency-based AP overpayment recovery audit.",
    totalValueUsd: 250000,
    milestones: [
      { title: "Data extract & profiling", valueUsd: 25000, status: "accepted", dueOffsetDays: 30 },
      { title: "Recovery wave 1", valueUsd: 100000, status: "invoiced", dueOffsetDays: 90 },
      { title: "Recovery wave 2", valueUsd: 75000, status: "in_progress", dueOffsetDays: 150 },
      { title: "Final report & true-up", valueUsd: 50000, status: "pending", dueOffsetDays: 210 },
    ],
    changeOrder: null,
  },
];

const RATE_CARD_TEMPLATES: Array<{
  name: string;
  /** "active" | "expired" | "active-with-leakage" */
  variant: "active" | "expired" | "leakage";
  lines: Array<{
    role: string;
    seniority: string;
    hourlyRate: number;
    geography: string;
  }>;
}> = [
  {
    name: "Standard Engineering Rates 2026",
    variant: "active",
    lines: [
      { role: "Software Engineer", seniority: "Junior", hourlyRate: 95, geography: "US" },
      { role: "Software Engineer", seniority: "Senior", hourlyRate: 165, geography: "US" },
      { role: "Software Engineer", seniority: "Principal", hourlyRate: 230, geography: "US" },
      { role: "Engineering Manager", seniority: "Senior", hourlyRate: 220, geography: "US" },
    ],
  },
  {
    name: "Standard Engineering Rates 2024",
    variant: "expired",
    lines: [
      { role: "Software Engineer", seniority: "Junior", hourlyRate: 85, geography: "US" },
      { role: "Software Engineer", seniority: "Senior", hourlyRate: 150, geography: "US" },
      { role: "Software Engineer", seniority: "Principal", hourlyRate: 210, geography: "US" },
    ],
  },
  {
    name: "Cyber Advisory Rates 2026",
    variant: "leakage",
    lines: [
      { role: "Security Analyst", seniority: "Junior", hourlyRate: 110, geography: "US" },
      { role: "Security Analyst", seniority: "Senior", hourlyRate: 195, geography: "US" },
      { role: "Incident Response Lead", seniority: "Principal", hourlyRate: 285, geography: "US" },
    ],
  },
  {
    name: "Data Engineering Rates 2026",
    variant: "active",
    lines: [
      { role: "Data Engineer", seniority: "Junior", hourlyRate: 100, geography: "US" },
      { role: "Data Engineer", seniority: "Senior", hourlyRate: 175, geography: "US" },
      { role: "Analytics Engineer", seniority: "Senior", hourlyRate: 165, geography: "US" },
      { role: "ML Engineer", seniority: "Principal", hourlyRate: 245, geography: "US" },
    ],
  },
  {
    name: "M&A Advisory Rates 2026",
    variant: "active",
    lines: [
      { role: "Associate", seniority: "Junior", hourlyRate: 220, geography: "US" },
      { role: "Manager", seniority: "Senior", hourlyRate: 360, geography: "US" },
      { role: "Partner", seniority: "Principal", hourlyRate: 650, geography: "US" },
    ],
  },
];

async function seedServicesDemoForOrg(orgId: string): Promise<void> {
  // 1. Pick the first 5 services-class contracts (deterministic order).
  const candidateRows = await db.execute(sql`
    SELECT c.id, c.supplier_id, c.start_date, c.end_date, c.contract_type
    FROM contracts c
    JOIN categories cat ON cat.id = c.category_id
    WHERE c.org_id = ${orgId}
      AND cat.class = 'service'
    ORDER BY c.contract_number ASC
    LIMIT 5
  `);
  const contracts = candidateRows.rows as Array<{
    id: string;
    supplier_id: string;
    start_date: Date | string;
    end_date: Date | string;
    contract_type: string;
  }>;
  if (contracts.length < 5) {
    console.log(
      `[seed] services demo skipped for ${orgId}: needs ≥5 services-class contracts (have ${contracts.length})`,
    );
    return;
  }

  // 2. Stamp each contract with a distinct services contract_type.
  //    Only overwrite rows that are still `goods` so manual overrides
  //    in the demo env survive re-runs.
  for (let i = 0; i < SOW_TEMPLATES.length; i++) {
    const t = SOW_TEMPLATES[i]!;
    const c = contracts[i]!;
    await db.execute(sql`
      UPDATE contracts
      SET contract_type = ${t.contractType}
      WHERE id = ${c.id} AND contract_type = 'goods'
    `);
  }

  // 3. Insert one SOW per MSA + milestones + (optional) change order.
  const now = new Date();
  for (let i = 0; i < SOW_TEMPLATES.length; i++) {
    const t = SOW_TEMPLATES[i]!;
    const c = contracts[i]!;
    const startDate = new Date(c.start_date);
    const endDate = new Date(c.end_date);
    const sowId = `sow_${SVC_DEMO_SOURCE}_${orgId}_${i + 1}`.slice(0, 64);
    const externalId = `${SVC_DEMO_SOURCE}-${orgId}-sow-${i + 1}`;

    await db
      .insert(statementsOfWorkTable)
      .values({
        id: sowId,
        orgId,
        contractId: c.id,
        supplierId: c.supplier_id,
        sowNumber: `SOW-DEMO-${i + 1}`,
        title: t.titleSuffix,
        status: "active",
        startDate,
        endDate,
        totalValueUsd: t.totalValueUsd.toFixed(2),
        billingCurrency: "USD",
        scope: { summary: t.scope },
        acceptanceCriteria:
          "Each milestone deliverable accepted in writing by the engagement sponsor within 10 business days of submission.",
        sourceSystem: SVC_DEMO_SOURCE,
        sourceExternalId: externalId,
      })
      .onConflictDoNothing();

    // Milestones — keyed by (sowId, milestoneNumber).
    const milestoneRows = t.milestones.map((m, idx) => {
      const due = new Date(startDate.getTime());
      due.setDate(due.getDate() + m.dueOffsetDays);
      const delivered =
        m.status === "delivered" || m.status === "accepted" || m.status === "invoiced" || m.status === "paid"
          ? new Date(due.getTime() - 24 * 60 * 60 * 1000)
          : null;
      const accepted =
        m.status === "accepted" || m.status === "invoiced" || m.status === "paid" ? due : null;
      return {
        id: `som_${SVC_DEMO_SOURCE}_${orgId}_${i + 1}_${idx + 1}`.slice(0, 64),
        orgId,
        sowId,
        milestoneNumber: idx + 1,
        title: m.title,
        description: null,
        dueDate: due,
        valueUsd: m.valueUsd.toFixed(2),
        status: m.status,
        deliveredAt: delivered,
        acceptedAt: accepted,
      };
    });
    await db.insert(sowMilestonesTable).values(milestoneRows).onConflictDoNothing();

    if (t.changeOrder) {
      await db
        .insert(sowChangeOrdersTable)
        .values({
          id: `sco_${SVC_DEMO_SOURCE}_${orgId}_${i + 1}`.slice(0, 64),
          orgId,
          sowId,
          changeOrderNumber: "CO-1",
          title: t.changeOrder.title,
          description: t.changeOrder.description,
          status: "approved",
          valueDeltaUsd: t.changeOrder.valueDeltaUsd.toFixed(2),
          dateDeltaDays: t.changeOrder.dateDeltaDays,
          proposedAt: new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000),
          executedAt: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
          approver: t.changeOrder.approver,
          sourceSystem: SVC_DEMO_SOURCE,
          sourceExternalId: `${SVC_DEMO_SOURCE}-${orgId}-co-${i + 1}`,
        })
        .onConflictDoNothing();
    }
  }

  // 4. Rate cards. Each card sits on the i-th supplier/contract pair so
  //    we exercise the MSA-linked detail view as well as the supplier
  //    join. Variant controls active/expired and whether we plant
  //    off-card time entries.
  for (let i = 0; i < RATE_CARD_TEMPLATES.length; i++) {
    const t = RATE_CARD_TEMPLATES[i]!;
    const c = contracts[i]!;
    const cardId = `rc_${SVC_DEMO_SOURCE}_${orgId}_${i + 1}`.slice(0, 64);
    const externalId = `${SVC_DEMO_SOURCE}-${orgId}-rc-${i + 1}`;

    let effective: Date;
    let expiry: Date | null;
    if (t.variant === "expired") {
      // Effective two years ago, expired six months ago.
      effective = new Date(now.getTime() - 730 * 24 * 60 * 60 * 1000);
      expiry = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
    } else {
      effective = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      expiry = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
    }

    await db
      .insert(rateCardsTable)
      .values({
        id: cardId,
        orgId,
        contractId: c.id,
        sowId: null,
        supplierId: c.supplier_id,
        name: t.name,
        currency: "USD",
        effectiveDate: effective,
        expiryDate: expiry,
        sourceSystem: SVC_DEMO_SOURCE,
        sourceExternalId: externalId,
      })
      .onConflictDoNothing();

    const lineRows = t.lines.map((l, idx) => ({
      id: `rcl_${SVC_DEMO_SOURCE}_${orgId}_${i + 1}_${idx + 1}`.slice(0, 64),
      orgId,
      rateCardId: cardId,
      role: l.role,
      seniority: l.seniority,
      hourlyRate: l.hourlyRate.toFixed(4),
      dailyRate: null,
      roleCode: null,
      geography: l.geography,
      billingModel: "t_and_m",
    }));
    await db.insert(rateCardLinesTable).values(lineRows).onConflictDoNothing();

    // Off-card time entries — only for the leakage variant. Five
    // entries against this card with rate_card_line_id NULL drive the
    // off-card aggregate on the rate-card detail panel.
    if (t.variant === "leakage") {
      const offEntries = Array.from({ length: 5 }, (_, k) => {
        const workDate = new Date(now.getTime() - (k + 1) * 14 * 24 * 60 * 60 * 1000);
        const hours = 32;
        const billRate = 235; // above the card's senior rate
        return {
          id: `te_${SVC_DEMO_SOURCE}_${orgId}_${i + 1}_${k + 1}`.slice(0, 64),
          orgId,
          supplierId: c.supplier_id,
          contractId: c.id,
          sowId: null,
          rateCardId: cardId,
          rateCardLineId: null,
          resource: `Off-card Resource ${k + 1}`,
          role: "Security Analyst",
          seniority: "Senior",
          workDate,
          hours: hours.toFixed(2),
          billRateUsd: billRate.toFixed(4),
          amountUsd: (hours * billRate).toFixed(2),
          description: "Ad-hoc engagement billed outside the rate card.",
          sourceSystem: SVC_DEMO_SOURCE,
          sourceExternalId: `${SVC_DEMO_SOURCE}-${orgId}-te-${i + 1}-${k + 1}`,
        };
      });
      await db.insert(timeEntriesTable).values(offEntries).onConflictDoNothing();
    }
  }

  console.log(
    `[seed] services demo ensured on ${orgId}: 5 SOWs (${SOW_TEMPLATES.map((t) => t.contractType).join(", ")}) + 5 rate cards`,
  );
}

async function seedServicesDemo(): Promise<void> {
  // Run for every org that already has ≥5 services-class contracts. In
  // a freshly-pushed dev DB there typically are none, so this is a
  // no-op until the demo dataset is loaded; in the SCIS / ProcureWorks
  // demo envs it lights up the Services workspace.
  const rows = await db.execute(sql`
    SELECT c.org_id, COUNT(*) AS n
    FROM contracts c
    JOIN categories cat ON cat.id = c.category_id
    WHERE cat.class = 'service'
    GROUP BY c.org_id
    HAVING COUNT(*) >= 5
    ORDER BY c.org_id
  `);
  const orgs = (rows.rows as Array<{ org_id: string; n: string }>).map(
    (r) => r.org_id,
  );
  if (orgs.length === 0) {
    console.log(
      `[seed] services demo: no orgs with ≥5 services-class contracts — skipping`,
    );
    return;
  }
  for (const orgId of orgs) {
    await seedServicesDemoForOrg(orgId);
  }
}

async function main(): Promise<void> {
  console.log(`[seed] starting at ${new Date().toISOString()}`);
  await seedOrgs();
  await seedTaxonomyBands();
  await seedFxExposureDemo();
  await seedServicesDemo();
  console.log(`[seed] complete`);
}

main()
  .catch((err) => {
    console.error("[seed] failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
