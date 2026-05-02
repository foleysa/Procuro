/**
 * Integration test for `POST /api/ingest/csv-stream` covering every
 * higher-risk non-`suppliers` entity — `invoices`, `po_lines`,
 * `purchase_orders`, `payments`, `shipments`, `statements_of_work`,
 * `rate_cards`, `rate_card_lines`, and `time_entries` — with a CSV that
 * exceeds the per-entity row budget (`TARGET_ROWS`; configurable via
 * `CSV_STREAM_FIXTURE_ROWS` for ad-hoc stress runs).
 *
 * Why this exists
 * ---------------
 * `csv-stream-large.test.ts` only exercises `suppliers`, which has the
 * simplest per-batch logic (no foreign-key lookups). The streaming endpoint
 * accepts eleven other entities. The highest-volume entity in real
 * customer data — `po_lines` — has the most complex per-batch logic: it
 * runs grouped lookups against `purchase_orders` AND `categories` for every
 * batch before the upsert. `invoices`, `purchase_orders`, `payments`,
 * `shipments`, `statements_of_work`, `rate_cards`, `rate_card_lines`,
 * and `time_entries` each run one to four grouped foreign-key lookups
 * per batch before their upsert. A regression in any of those lookup
 * paths would silently drop customer data and the suppliers-only test
 * would not catch it.
 *
 * What this verifies (per entity)
 * -------------------------------
 * 1. Generates a multi-batch single-entity CSV directly to disk (never
 *    buffered as a single string in JS).
 * 2. Boots the real Express app in-process and binds to an ephemeral port,
 *    then POSTs the file as `multipart/form-data` so the server hits the
 *    same code path the browser/cURL clients use.
 * 3. Confirms the streaming endpoint reports `rowsParsed === rowsInserted`
 *    and that count matches the number of rows in the generated file.
 * 4. Confirms the rows actually landed in the real Postgres database
 *    (DATABASE_URL — no mocks) by counting rows filtered to a unique
 *    `source_external_id` prefix that this test owns.
 * 5. Cleans up every row inserted by this run (parents and children) in
 *    foreign-key-safe order.
 *
 * What this test deliberately does NOT cover
 * ------------------------------------------
 * - Memory-regression assertion (already covered by `csv-stream-large.test.ts`
 *   for the streaming code path itself; entity-specific batch handlers do
 *   not change that property).
 *
 * Prereqs
 * -------
 * - `DATABASE_URL` is set and the schema has been pushed (see `lib/db`).
 * - At least one row exists in `orgs` (the test will use the first one).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// Opt into the dev-only `x-org-id` header path before importing the app
// (the auth middleware reads NODE_ENV at module import time).
process.env["NODE_ENV"] = process.env["NODE_ENV"] ?? "development";
process.env["ALLOW_DEV_TENANT_HEADER"] = "true";

import {
  db,
  contractsTable,
  invoicesTable,
  paymentsTable,
  poLinesTable,
  purchaseOrdersTable,
  rateCardsTable,
  rateCardLinesTable,
  shipmentsTable,
  statementsOfWorkTable,
  timeEntriesTable,
  pool,
} from "@workspace/db";
import { and, eq, inArray, like } from "drizzle-orm";
import app from "../src/app";
import { parseTerminalNdjsonEvent } from "./helpers/ndjson";
import {
  FIXTURE_SOURCE,
  deleteFixtureRowsByPrefix,
  loadSupplierIdMapByPrefix,
  openAsBlob,
  pickOrgId,
  seedCategories,
  seedContracts,
  seedInvoices,
  seedPurchaseOrders,
  seedRateCards,
  seedStatementsOfWork,
  seedSuppliers,
  startServer,
  writeInvoicesCsvSync,
  writePaymentsCsvSync,
  writePoLinesCsvSync,
  writePurchaseOrdersCsvSync,
  writeRateCardLinesCsvSync,
  writeRateCardsCsvSync,
  writeShipmentsCsvSync,
  writeStatementsOfWorkCsvSync,
  writeTimeEntriesCsvSync,
} from "./helpers/csv-stream-fixtures";

const TEST_RUN_ID = `csvstreamentities-${Date.now()}-${process.pid}`;
const EXTERNAL_ID_PREFIX = `${TEST_RUN_ID}-`;
// Per-entity CSV fixture row count. The earlier byte-sized fixture (10 MB,
// later 3 MB) made each variant insert 12k–28k rows just to satisfy a
// file-size threshold that wasn't testing anything the streaming endpoint
// actually exposes — the file-size guard caught no regression that the
// `rowsParsed === rowsInserted` + DB-row-count assertions don't already
// catch. What the test really needs to cover is the per-batch flush path
// (`BATCH_SIZE = 1000`): every variant must trigger >1 flush so the
// grouped FK lookup map carries multiple hits per batch.
//
// 2_500 rows == 3 batch flushes (1_000 + 1_000 + 500). With 50 seeded
// parents per variant and round-robin assignment, each batch resolves
// against ~50 distinct FK keys — exercising the same `IN (...)` lookup
// shape the previous 11–28 batch fixture exercised, in ~1/7 the inserts.
//
// Override with `CSV_STREAM_FIXTURE_ROWS` for ad-hoc local stress runs
// (e.g. `CSV_STREAM_FIXTURE_ROWS=20000` to reproduce a perf bug). The
// floor is BATCH_SIZE * 2 + 1 so the multi-flush invariant is impossible
// to silently break via env override.
const TARGET_ROWS = (() => {
  const raw = Number(process.env["CSV_STREAM_FIXTURE_ROWS"] ?? "");
  if (Number.isFinite(raw) && raw >= 2001) return Math.floor(raw);
  return 2_500;
})();

// Number of parent rows pre-seeded for child-CSV lookups. Small enough that
// the per-batch `IN (...)` lookup fits in a single grouped query, large
// enough that the lookup map is exercised (i.e. not a single hit).
const PARENT_SUPPLIERS = 50;
const PARENT_POS = 50;
const PARENT_CATEGORIES = 5;
// Dedicated parent invoices for the `payments` variant. Kept small (matches
// the supplier/PO parent counts) so each batch's grouped FK lookup against
// `invoices` is exercised — i.e. the lookup map has multiple hits per batch
// rather than a single hit which would fail to catch a misplaced filter.
const PARENT_INVOICES = 50;
// Dedicated parent contracts / SOWs / rate cards for the services-taxonomy
// entity variants (`statements_of_work`, `rate_cards`, `rate_card_lines`,
// `time_entries`). Same rationale as the other parent counts — small enough
// that the grouped FK lookup fits in a single query, large enough that each
// batch's lookup map has multiple hits.
const PARENT_CONTRACTS = 50;
const PARENT_SOWS = 50;
const PARENT_RATE_CARDS = 50;

/** Upload a CSV via the multipart streaming endpoint. */
async function uploadCsv(args: {
  baseUrl: string;
  orgId: string;
  entity: string;
  filePath: string;
  formFilename: string;
}): Promise<{ status: number; rawBody: string }> {
  const fileBlob = await openAsBlob(args.filePath, "text/csv");
  const form = new FormData();
  form.append("file", fileBlob, args.formFilename);
  const url = `${args.baseUrl}/api/ingest/csv-stream?entity=${args.entity}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "x-org-id": args.orgId },
    body: form,
  });
  const rawBody = await res.text();
  return { status: res.status, rawBody };
}

test("streaming CSV ingest of large files lands every row for every supported entity", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }

  const tmpFiles: string[] = [];
  let server: Awaited<ReturnType<typeof startServer>> | null = null;

  t.after(async () => {
    try {
      await deleteFixtureRowsByPrefix(EXTERNAL_ID_PREFIX);
    } catch (err) {
      console.error("[cleanup] failed to delete test rows:", err);
    }
    if (server) await server.close();
    for (const f of tmpFiles) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
    // Drain pg pool so node:test exits cleanly. Idempotent-safe: pg's
    // Pool.end() rejects if called twice, so swallow.
    await pool.end().catch(() => {});
  });

  // Shared setup once.
  server = await startServer(app);
  const orgId = await pickOrgId();

  // Defensive cleanup of any leftover rows from a prior aborted run with the
  // same prefix (the prefix is timestamped + pid-suffixed so this is
  // normally a no-op).
  await deleteFixtureRowsByPrefix(EXTERNAL_ID_PREFIX);

  /**
   * One row per CSV-streaming entity covered by this test. Each variant:
   * - prepares the parent rows the per-batch lookups depend on (`prepare`),
   * - writes a multi-batch single-entity CSV (`writeCsv`; >TARGET_ROWS), and
   * - counts how many of THIS test run's rows actually landed in Postgres
   *   (`countInsertedDbRows`).
   *
   * `countInsertedDbRows` is per-variant rather than a generic
   * `(table, prefix)` pair because some entities (notably `rate_card_lines`)
   * have no `source_external_id` column and must be counted by joining
   * back to a parent table whose external-id prefix this run owns.
   *
   * Adding a new entity is a single new entry in this table — no
   * copy/paste of the upload + assertion plumbing.
   */
  type Variant = {
    entity:
      | "invoices"
      | "po_lines"
      | "purchase_orders"
      | "payments"
      | "shipments"
      | "statements_of_work"
      | "rate_cards"
      | "rate_card_lines"
      | "time_entries";
    /** Set up parent records and return whatever the writer needs. */
    prepare: () => Promise<{ writeArgs: unknown }>;
    /** Generate the multi-batch CSV row-by-row to disk; return row count. */
    writeCsv: (filePath: string, args: unknown) => number;
    /**
     * Count how many of this test run's inserted rows are currently in the
     * real Postgres database. Implemented per-variant so entities without
     * a `source_external_id` column (e.g. `rate_card_lines`) can count via
     * a join through their parent table.
     */
    countInsertedDbRows: () => Promise<number>;
  };

  /**
   * Look up the supplier id map for this run, seeding `PARENT_SUPPLIERS`
   * lazily if no suppliers are present yet. Used by every variant whose
   * upload references a supplier extId.
   */
  async function ensureSupplierIdMap(): Promise<Map<string, string>> {
    let map = await loadSupplierIdMapByPrefix(orgId, EXTERNAL_ID_PREFIX);
    if (map.size === 0) {
      await seedSuppliers(orgId, PARENT_SUPPLIERS, EXTERNAL_ID_PREFIX);
      map = await loadSupplierIdMapByPrefix(orgId, EXTERNAL_ID_PREFIX);
    }
    return map;
  }

  /**
   * Look up contracts seeded under this run's prefix and return both the
   * external IDs (for CSV references) and the internal IDs (for FK
   * references in further seeding). Seeds `PARENT_CONTRACTS` lazily if
   * none exist yet — `seedContracts` requires supplier internal IDs, so
   * the caller must pass the seeded supplier list.
   */
  async function ensureContracts(supplierIds: string[]): Promise<{
    externalIds: string[];
    internalIds: string[];
  }> {
    const existing = await db
      .select({
        id: contractsTable.id,
        ext: contractsTable.sourceExternalId,
      })
      .from(contractsTable)
      .where(
        and(
          eq(contractsTable.orgId, orgId),
          eq(contractsTable.sourceSystem, FIXTURE_SOURCE),
          like(
            contractsTable.sourceExternalId,
            `${EXTERNAL_ID_PREFIX}ct-%`,
          ),
        ),
      );
    if (existing.length > 0) {
      const externalIds = existing
        .map((r) => r.ext)
        .filter((x): x is string => Boolean(x));
      const internalIds = existing.map((r) => r.id);
      return { externalIds, internalIds };
    }
    return seedContracts(
      orgId,
      PARENT_CONTRACTS,
      supplierIds,
      EXTERNAL_ID_PREFIX,
    );
  }

  /**
   * Look up SOWs seeded under this run's prefix; seed
   * `PARENT_SOWS` lazily if none exist yet. Requires contract + supplier
   * internal IDs because `seedStatementsOfWork` needs both for FKs.
   */
  async function ensureStatementsOfWork(
    contractIds: string[],
    supplierIds: string[],
  ): Promise<{ externalIds: string[]; internalIds: string[] }> {
    const existing = await db
      .select({
        id: statementsOfWorkTable.id,
        ext: statementsOfWorkTable.sourceExternalId,
      })
      .from(statementsOfWorkTable)
      .where(
        and(
          eq(statementsOfWorkTable.orgId, orgId),
          eq(statementsOfWorkTable.sourceSystem, FIXTURE_SOURCE),
          like(
            statementsOfWorkTable.sourceExternalId,
            `${EXTERNAL_ID_PREFIX}sow-%`,
          ),
        ),
      );
    if (existing.length > 0) {
      const externalIds = existing
        .map((r) => r.ext)
        .filter((x): x is string => Boolean(x));
      const internalIds = existing.map((r) => r.id);
      return { externalIds, internalIds };
    }
    return seedStatementsOfWork(
      orgId,
      PARENT_SOWS,
      contractIds,
      supplierIds,
      EXTERNAL_ID_PREFIX,
    );
  }

  /**
   * Look up rate cards seeded under this run's prefix; seed
   * `PARENT_RATE_CARDS` lazily if none exist yet. Optional contract /
   * SOW internal IDs are passed straight through to `seedRateCards`.
   */
  async function ensureRateCards(
    supplierIds: string[],
    opts?: { contractIds?: string[]; sowIds?: string[] },
  ): Promise<{ externalIds: string[]; internalIds: string[] }> {
    const existing = await db
      .select({
        id: rateCardsTable.id,
        ext: rateCardsTable.sourceExternalId,
      })
      .from(rateCardsTable)
      .where(
        and(
          eq(rateCardsTable.orgId, orgId),
          eq(rateCardsTable.sourceSystem, FIXTURE_SOURCE),
          like(
            rateCardsTable.sourceExternalId,
            `${EXTERNAL_ID_PREFIX}rc-%`,
          ),
        ),
      );
    if (existing.length > 0) {
      const externalIds = existing
        .map((r) => r.ext)
        .filter((x): x is string => Boolean(x));
      const internalIds = existing.map((r) => r.id);
      return { externalIds, internalIds };
    }
    return seedRateCards(
      orgId,
      PARENT_RATE_CARDS,
      supplierIds,
      EXTERNAL_ID_PREFIX,
      opts,
    );
  }

  /**
   * Standard prefix-scoped row counter used by every variant whose target
   * table has a `(sourceSystem, sourceExternalId)` pair. Handles the
   * generic `WHERE sourceSystem='csv' AND sourceExternalId LIKE 'prefix%'`
   * shape so per-variant `countInsertedDbRows` stays a single line.
   */
  async function countByExtIdPrefix(
    table:
      | typeof invoicesTable
      | typeof poLinesTable
      | typeof purchaseOrdersTable
      | typeof paymentsTable
      | typeof shipmentsTable
      | typeof statementsOfWorkTable
      | typeof rateCardsTable
      | typeof timeEntriesTable,
    extIdPrefix: string,
  ): Promise<number> {
    const rows = await db
      .select({ id: table.id })
      .from(table)
      .where(
        and(
          eq(table.sourceSystem, FIXTURE_SOURCE),
          like(table.sourceExternalId, `${extIdPrefix}%`),
        ),
      );
    return rows.length;
  }

  const variants: Variant[] = [
    {
      entity: "invoices",
      prepare: async () => {
        const supplierExternalIds = await seedSuppliers(
          orgId,
          PARENT_SUPPLIERS,
          EXTERNAL_ID_PREFIX,
        );
        return { writeArgs: { supplierExternalIds } };
      },
      writeCsv: (filePath, args) => {
        const { supplierExternalIds } = args as {
          supplierExternalIds: string[];
        };
        return writeInvoicesCsvSync(filePath, {
          supplierExternalIds,
          extIdPrefix: EXTERNAL_ID_PREFIX,
          rowCount: TARGET_ROWS,
        });
      },
      countInsertedDbRows: () =>
        countByExtIdPrefix(invoicesTable, `${EXTERNAL_ID_PREFIX}inv-`),
    },
    {
      entity: "po_lines",
      prepare: async () => {
        // Reuse supplier seeds from earlier variants if present; otherwise
        // create them now. Either way we need the internal supplier ids to
        // build POs.
        const supplierIdMap = await ensureSupplierIdMap();
        const supplierIds = Array.from(supplierIdMap.values());
        assert.ok(
          supplierIds.length > 0,
          "expected at least one seeded supplier for PO seeding",
        );
        const poExternalIds = await seedPurchaseOrders(
          orgId,
          PARENT_POS,
          supplierIds,
          EXTERNAL_ID_PREFIX,
        );
        const categoryCodes = await seedCategories(
          orgId,
          PARENT_CATEGORIES,
          EXTERNAL_ID_PREFIX,
        );
        return { writeArgs: { poExternalIds, categoryCodes } };
      },
      writeCsv: (filePath, args) => {
        const { poExternalIds, categoryCodes } = args as {
          poExternalIds: string[];
          categoryCodes: string[];
        };
        return writePoLinesCsvSync(filePath, {
          poExternalIds,
          categoryCodes,
          extIdPrefix: EXTERNAL_ID_PREFIX,
          rowCount: TARGET_ROWS,
        });
      },
      countInsertedDbRows: () =>
        countByExtIdPrefix(poLinesTable, `${EXTERNAL_ID_PREFIX}pol-`),
    },
    {
      entity: "purchase_orders",
      prepare: async () => {
        // Reuse seeded suppliers from earlier variants when present; otherwise
        // create them now. The CSV references suppliers by external ID so we
        // only need the strings, not internal ids.
        const supplierIdMap = await ensureSupplierIdMap();
        const supplierExternalIds = Array.from(supplierIdMap.keys());
        assert.ok(
          supplierExternalIds.length > 0,
          "expected at least one seeded supplier extId for PO upload",
        );
        return { writeArgs: { supplierExternalIds } };
      },
      writeCsv: (filePath, args) => {
        const { supplierExternalIds } = args as {
          supplierExternalIds: string[];
        };
        return writePurchaseOrdersCsvSync(filePath, {
          supplierExternalIds,
          extIdPrefix: EXTERNAL_ID_PREFIX,
          rowCount: TARGET_ROWS,
        });
      },
      // `writePurchaseOrdersCsvSync` uses `upo-` so uploaded POs do NOT
      // collide with the `po-` parents seeded for the po_lines variant.
      countInsertedDbRows: () =>
        countByExtIdPrefix(
          purchaseOrdersTable,
          `${EXTERNAL_ID_PREFIX}upo-`,
        ),
    },
    {
      entity: "payments",
      prepare: async () => {
        // Payments need parent invoices. We can't reuse invoices uploaded by
        // the earlier `invoices` variant because their batch-load cost grows
        // with the upload size; seed a small dedicated set instead so each
        // payment batch resolves through the same FK lookup map shape.
        const supplierIdMap = await ensureSupplierIdMap();
        const supplierIds = Array.from(supplierIdMap.values());
        assert.ok(
          supplierIds.length > 0,
          "expected at least one seeded supplier for invoice seeding",
        );
        const invoiceExternalIds = await seedInvoices(
          orgId,
          PARENT_INVOICES,
          supplierIds,
          EXTERNAL_ID_PREFIX,
        );
        return { writeArgs: { invoiceExternalIds } };
      },
      writeCsv: (filePath, args) => {
        const { invoiceExternalIds } = args as {
          invoiceExternalIds: string[];
        };
        return writePaymentsCsvSync(filePath, {
          invoiceExternalIds,
          extIdPrefix: EXTERNAL_ID_PREFIX,
          rowCount: TARGET_ROWS,
        });
      },
      countInsertedDbRows: () =>
        countByExtIdPrefix(paymentsTable, `${EXTERNAL_ID_PREFIX}pay-`),
    },
    {
      entity: "shipments",
      prepare: async () => {
        // Reuse suppliers and POs seeded by earlier variants; seed any that
        // are missing so this variant can run independently.
        const supplierIdMap = await ensureSupplierIdMap();
        const supplierExternalIds = Array.from(supplierIdMap.keys());
        // Need PO external IDs for the shipments CSV. The po_lines variant
        // seeds them under the same prefix; query the table directly so this
        // variant works regardless of variant ordering.
        const poRows = await db
          .select({ ext: purchaseOrdersTable.sourceExternalId })
          .from(purchaseOrdersTable)
          .where(
            and(
              eq(purchaseOrdersTable.orgId, orgId),
              eq(purchaseOrdersTable.sourceSystem, FIXTURE_SOURCE),
              like(
                purchaseOrdersTable.sourceExternalId,
                `${EXTERNAL_ID_PREFIX}po-%`,
              ),
            ),
          );
        let poExternalIds = poRows
          .map((r) => r.ext)
          .filter((x): x is string => Boolean(x));
        if (poExternalIds.length === 0) {
          const supplierIds = Array.from(supplierIdMap.values());
          poExternalIds = await seedPurchaseOrders(
            orgId,
            PARENT_POS,
            supplierIds,
            EXTERNAL_ID_PREFIX,
          );
        }
        assert.ok(
          poExternalIds.length > 0,
          "expected at least one seeded PO extId for shipments upload",
        );
        return { writeArgs: { poExternalIds, supplierExternalIds } };
      },
      writeCsv: (filePath, args) => {
        const { poExternalIds, supplierExternalIds } = args as {
          poExternalIds: string[];
          supplierExternalIds: string[];
        };
        return writeShipmentsCsvSync(filePath, {
          poExternalIds,
          supplierExternalIds,
          extIdPrefix: EXTERNAL_ID_PREFIX,
          rowCount: TARGET_ROWS,
        });
      },
      countInsertedDbRows: () =>
        countByExtIdPrefix(shipmentsTable, `${EXTERNAL_ID_PREFIX}shp-`),
    },
    {
      entity: "statements_of_work",
      prepare: async () => {
        // SOW flushBatch needs both `contractExternalId` and
        // `supplierExternalId` lookups, so seed both parent sets and pass
        // their external IDs to the writer.
        const supplierIdMap = await ensureSupplierIdMap();
        const supplierIds = Array.from(supplierIdMap.values());
        const supplierExternalIds = Array.from(supplierIdMap.keys());
        const { externalIds: contractExternalIds } =
          await ensureContracts(supplierIds);
        return {
          writeArgs: { contractExternalIds, supplierExternalIds },
        };
      },
      writeCsv: (filePath, args) => {
        const { contractExternalIds, supplierExternalIds } = args as {
          contractExternalIds: string[];
          supplierExternalIds: string[];
        };
        return writeStatementsOfWorkCsvSync(filePath, {
          contractExternalIds,
          supplierExternalIds,
          extIdPrefix: EXTERNAL_ID_PREFIX,
          rowCount: TARGET_ROWS,
        });
      },
      countInsertedDbRows: () =>
        countByExtIdPrefix(
          statementsOfWorkTable,
          `${EXTERNAL_ID_PREFIX}usow-`,
        ),
    },
    {
      entity: "rate_cards",
      prepare: async () => {
        // Exercise all three FK lookup paths in `flushBatch` for rate
        // cards: required `supplier`, optional `contract`, optional `sow`.
        const supplierIdMap = await ensureSupplierIdMap();
        const supplierIds = Array.from(supplierIdMap.values());
        const supplierExternalIds = Array.from(supplierIdMap.keys());
        const { externalIds: contractExternalIds, internalIds: contractIds } =
          await ensureContracts(supplierIds);
        const { externalIds: sowExternalIds } =
          await ensureStatementsOfWork(contractIds, supplierIds);
        return {
          writeArgs: {
            supplierExternalIds,
            contractExternalIds,
            sowExternalIds,
          },
        };
      },
      writeCsv: (filePath, args) => {
        const { supplierExternalIds, contractExternalIds, sowExternalIds } =
          args as {
            supplierExternalIds: string[];
            contractExternalIds: string[];
            sowExternalIds: string[];
          };
        return writeRateCardsCsvSync(filePath, {
          supplierExternalIds,
          contractExternalIds,
          sowExternalIds,
          extIdPrefix: EXTERNAL_ID_PREFIX,
          rowCount: TARGET_ROWS,
        });
      },
      countInsertedDbRows: () =>
        countByExtIdPrefix(rateCardsTable, `${EXTERNAL_ID_PREFIX}urc-`),
    },
    {
      entity: "rate_card_lines",
      prepare: async () => {
        // Rate-card lines only need rate-card parents — every other join
        // (role/seniority -> rate) lives entirely on the line itself.
        // Seed the parent rate-cards (with their own contract/SOW chain)
        // so the lookup map has multiple hits per batch.
        const supplierIdMap = await ensureSupplierIdMap();
        const supplierIds = Array.from(supplierIdMap.values());
        const { externalIds: contractExternalIds, internalIds: contractIds } =
          await ensureContracts(supplierIds);
        // Force at least one SOW to exist so the rate-card seed can chain
        // both FK columns (`contract_id`, `sow_id`); otherwise the seed
        // would leave both null which is uninteresting for our lookup
        // surface.
        const { internalIds: sowIds } = await ensureStatementsOfWork(
          contractIds,
          supplierIds,
        );
        const { externalIds: rateCardExternalIds } = await ensureRateCards(
          supplierIds,
          { contractIds, sowIds },
        );
        return { writeArgs: { rateCardExternalIds } };
      },
      writeCsv: (filePath, args) => {
        const { rateCardExternalIds } = args as {
          rateCardExternalIds: string[];
        };
        return writeRateCardLinesCsvSync(filePath, {
          rateCardExternalIds,
          extIdPrefix: EXTERNAL_ID_PREFIX,
          rowCount: TARGET_ROWS,
        });
      },
      countInsertedDbRows: async () => {
        // `rate_card_lines` has no `source_external_id` column; count via
        // the parent rate-cards' prefixed external IDs instead. The
        // parents seeded in `prepare` use the `${prefix}rc-` namespace,
        // and since lines cascade-delete with their parent we know all
        // surviving lines under those parents are this run's.
        const rows = await db
          .select({ id: rateCardLinesTable.id })
          .from(rateCardLinesTable)
          .where(
            inArray(
              rateCardLinesTable.rateCardId,
              db
                .select({ id: rateCardsTable.id })
                .from(rateCardsTable)
                .where(
                  and(
                    eq(rateCardsTable.orgId, orgId),
                    eq(rateCardsTable.sourceSystem, FIXTURE_SOURCE),
                    like(
                      rateCardsTable.sourceExternalId,
                      `${EXTERNAL_ID_PREFIX}rc-%`,
                    ),
                  ),
                ),
            ),
          );
        return rows.length;
      },
    },
    {
      entity: "time_entries",
      prepare: async () => {
        // Time-entry flushBatch performs four grouped FK lookups
        // (`supplier` required, `contract` / `sow` / `rate_card`
        // optional). Seed all four parent sets so each lookup map has
        // multiple hits per batch — a regression in any of them would
        // silently drop data and we want this variant to catch it.
        const supplierIdMap = await ensureSupplierIdMap();
        const supplierIds = Array.from(supplierIdMap.values());
        const supplierExternalIds = Array.from(supplierIdMap.keys());
        const { externalIds: contractExternalIds, internalIds: contractIds } =
          await ensureContracts(supplierIds);
        const { externalIds: sowExternalIds, internalIds: sowIds } =
          await ensureStatementsOfWork(contractIds, supplierIds);
        const { externalIds: rateCardExternalIds } = await ensureRateCards(
          supplierIds,
          { contractIds, sowIds },
        );
        return {
          writeArgs: {
            supplierExternalIds,
            contractExternalIds,
            sowExternalIds,
            rateCardExternalIds,
          },
        };
      },
      writeCsv: (filePath, args) => {
        const {
          supplierExternalIds,
          contractExternalIds,
          sowExternalIds,
          rateCardExternalIds,
        } = args as {
          supplierExternalIds: string[];
          contractExternalIds: string[];
          sowExternalIds: string[];
          rateCardExternalIds: string[];
        };
        return writeTimeEntriesCsvSync(filePath, {
          supplierExternalIds,
          contractExternalIds,
          sowExternalIds,
          rateCardExternalIds,
          extIdPrefix: EXTERNAL_ID_PREFIX,
          rowCount: TARGET_ROWS,
        });
      },
      countInsertedDbRows: () =>
        countByExtIdPrefix(timeEntriesTable, `${EXTERNAL_ID_PREFIX}te-`),
    },
  ];

  for (const variant of variants) {
    await t.test(`entity: ${variant.entity}`, async () => {
      const tmpFile = path.join(
        os.tmpdir(),
        `csv-stream-large-${variant.entity}-${process.pid}-${Date.now()}.csv`,
      );
      tmpFiles.push(tmpFile);

      const { writeArgs } = await variant.prepare();
      const expectedRows = variant.writeCsv(tmpFile, writeArgs);

      // Each variant must trigger >1 BATCH_SIZE (1000) flush so the
      // grouped FK lookup map carries multiple hits per batch — that's
      // the per-batch handler regression this whole suite exists to
      // catch. Asserting 2_001+ rows (rather than `>= TARGET_ROWS`)
      // guards the invariant directly so a future rewrite of the row
      // budget can't silently regress the coverage shape.
      assert.ok(
        expectedRows > 2_000,
        `Generated ${variant.entity} CSV must produce >1 BATCH_SIZE flush ` +
          `(>2000 rows); got ${expectedRows}.`,
      );
      const stat = fs.statSync(tmpFile);
      console.log(
        `[${variant.entity}] generated CSV: ${(stat.size / 1024 / 1024).toFixed(2)} MB, ${expectedRows} rows`,
      );

      const { status, rawBody } = await uploadCsv({
        baseUrl: server!.baseUrl,
        orgId,
        entity: variant.entity,
        filePath: tmpFile,
        formFilename: `${variant.entity}.csv`,
      });
      assert.equal(status, 200, `unexpected status ${status}: ${rawBody}`);

      const event = parseTerminalNdjsonEvent(rawBody);
      assert.equal(
        event.type,
        "result",
        `expected terminal event 'result', got ${event.type}: ${rawBody.slice(0, 200)}`,
      );
      if (event.type !== "result") return; // type narrow
      assert.equal(event.entity, variant.entity);
      assert.equal(
        event.rowsParsed,
        expectedRows,
        `parser saw ${event.rowsParsed} rows, expected ${expectedRows}`,
      );
      assert.equal(
        event.rowsInserted,
        expectedRows,
        `db reported ${event.rowsInserted} inserted rows, expected ${expectedRows}`,
      );

      // Real DB shows the same count (filtered to this run only).
      await sleep(50);
      const dbRowCount = await variant.countInsertedDbRows();
      assert.equal(
        dbRowCount,
        expectedRows,
        `${variant.entity} DB row count mismatch: got ${dbRowCount}, expected ${expectedRows}`,
      );
    });
  }
});
