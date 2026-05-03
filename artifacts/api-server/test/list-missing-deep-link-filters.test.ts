// Route-level coverage for the `?missing=` deep-link filters on
// GET /api/suppliers and GET /api/contracts (Task #193).
//
// The readiness-card URLs themselves are pinned by
// `readiness-rules-per-lever.test.ts`, but the corresponding API
// filters previously had only manual coverage. A regression that
// flipped, say, `isNull(billing_currency)` to `eq(billing_currency, …)`
// would compile cleanly and slip past CI. The tests below seed rows
// with a deliberate mix of populated/null/empty fields and assert
// each accepted `?missing=` value returns the expected subset of
// IDs.
//
// Convention follows `suppliers-list-billing-currency.test.ts`:
// fresh org per file, run-token search prefix for tenant-aware
// isolation, and `withServer` for an ephemeral HTTP server.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";

process.env["NODE_ENV"] = process.env["NODE_ENV"] ?? "development";
process.env["ALLOW_DEV_TENANT_HEADER"] = "true";

import { inArray } from "drizzle-orm";
import {
  contractsTable,
  db,
  orgsTable,
  suppliersTable,
  type InsertContractRow,
  type InsertSupplierRow,
} from "@workspace/db";
import app from "../src/app";

const RUN = `t193-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
const SOURCE = "csv";

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

async function withServer<T>(
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  try {
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("expected an AddressInfo for the test server");
    }
    return await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

type ListJson<T> = { items: T[]; nextCursor: string | null };

async function getJson<T>(
  baseUrl: string,
  path: string,
  orgId: string,
  query: Record<string, string>,
): Promise<{ status: number; json: ListJson<T> }> {
  const qs = new URLSearchParams(query).toString();
  const url = `${baseUrl}${path}${qs ? `?${qs}` : ""}`;
  const r = await fetch(url, { headers: { "x-org-id": orgId } });
  return { status: r.status, json: (await r.json()) as ListJson<T> };
}

// ─── Fixtures ─────────────────────────────────────────────────────────────
//
// Suppliers: four rows with every relevant combination of
// billing_currency × payment_terms_days populated/null/empty so each
// `?missing=` value picks exactly the row(s) we expect.
//
// Contracts: five rows covering populated/null/empty/zero on
// annual_baseline_usd, owner, and reference_index. `end_date` is
// intentionally not exercised here — the column is `NOT NULL` so the
// readiness rule already routes elsewhere (see contracts.ts comment).
let orgId: string;
let otherOrgId: string;

let supBoth: string; // billing_currency populated, payment_terms populated
let supNoCurrency: string; // null billing_currency
let supEmptyCurrency: string; // '' billing_currency (also counts as missing)
let supNoTerms: string; // null payment_terms_days
let supOtherTenant: string; // missing both — but in another org

let supplierForContracts: string;
let cFull: string; // every field populated
let cNoBaseline: string; // null annual_baseline_usd
let cZeroBaseline: string; // 0 annual_baseline_usd (treated as missing)
let cNoOwner: string; // empty owner
let cNoRefIndex: string; // null reference_index
let cOtherTenant: string; // missing every field but in another org
let supplierForOtherTenant: string;

describe("list ?missing= deep-link filters (#193)", () => {
  before(async () => {
    orgId = newId("org");
    otherOrgId = newId("org");
    await db.insert(orgsTable).values([
      { id: orgId, name: `${RUN} org`, slug: `${RUN}-a` },
      { id: otherOrgId, name: `${RUN} org other`, slug: `${RUN}-b` },
    ]);

    // ── Suppliers ──────────────────────────────────────────────────────
    supBoth = newId("sup");
    supNoCurrency = newId("sup");
    supEmptyCurrency = newId("sup");
    supNoTerms = newId("sup");
    supOtherTenant = newId("sup");

    const supplierRows: InsertSupplierRow[] = [
      {
        id: supBoth,
        orgId,
        name: `${RUN} both`,
        normalizedName: `${RUN} both`,
        sourceSystem: SOURCE,
        sourceExternalId: `${RUN}-both`,
        billingCurrency: "EUR",
        paymentTermsDays: "30",
      },
      {
        id: supNoCurrency,
        orgId,
        name: `${RUN} no-currency`,
        normalizedName: `${RUN} no-currency`,
        sourceSystem: SOURCE,
        sourceExternalId: `${RUN}-noc`,
        // billingCurrency omitted → null
        paymentTermsDays: "45",
      },
      {
        id: supEmptyCurrency,
        orgId,
        name: `${RUN} empty-currency`,
        normalizedName: `${RUN} empty-currency`,
        sourceSystem: SOURCE,
        sourceExternalId: `${RUN}-empc`,
        billingCurrency: "",
        paymentTermsDays: "60",
      },
      {
        id: supNoTerms,
        orgId,
        name: `${RUN} no-terms`,
        normalizedName: `${RUN} no-terms`,
        sourceSystem: SOURCE,
        sourceExternalId: `${RUN}-not`,
        billingCurrency: "USD",
        // paymentTermsDays omitted → null
      },
      {
        // Lives in another tenant; missing both fields. The route
        // must never leak it into orgId's results.
        id: supOtherTenant,
        orgId: otherOrgId,
        name: `${RUN} other-tenant`,
        normalizedName: `${RUN} other-tenant`,
        sourceSystem: SOURCE,
        sourceExternalId: `${RUN}-x`,
        // billingCurrency + paymentTermsDays omitted → both null
      },
    ];
    await db.insert(suppliersTable).values(supplierRows);

    // ── Contracts ──────────────────────────────────────────────────────
    // The contracts route requires a real supplier FK, so we mint one
    // per tenant whose own missing-field state isn't relevant to the
    // contract filter (it has currency + terms populated to keep the
    // supplier-side fixture from blurring with this suite's intent).
    supplierForContracts = newId("sup");
    supplierForOtherTenant = newId("sup");
    const contractsSupplierRows: InsertSupplierRow[] = [
      {
        id: supplierForContracts,
        orgId,
        name: `${RUN} c-supplier`,
        normalizedName: `${RUN} c-supplier`,
        sourceSystem: SOURCE,
        sourceExternalId: `${RUN}-csup`,
        billingCurrency: "USD",
        paymentTermsDays: "30",
      },
      {
        id: supplierForOtherTenant,
        orgId: otherOrgId,
        name: `${RUN} c-supplier-other`,
        normalizedName: `${RUN} c-supplier-other`,
        sourceSystem: SOURCE,
        sourceExternalId: `${RUN}-csupx`,
        billingCurrency: "USD",
        paymentTermsDays: "30",
      },
    ];
    await db.insert(suppliersTable).values(contractsSupplierRows);

    cFull = newId("ctr");
    cNoBaseline = newId("ctr");
    cZeroBaseline = newId("ctr");
    cNoOwner = newId("ctr");
    cNoRefIndex = newId("ctr");
    cOtherTenant = newId("ctr");

    const start = new Date("2026-01-01T00:00:00Z");
    const end = new Date("2027-01-01T00:00:00Z");

    const contractRows: InsertContractRow[] = [
      {
        id: cFull,
        orgId,
        supplierId: supplierForContracts,
        contractNumber: `${RUN}-FULL`,
        title: `${RUN} full`,
        startDate: start,
        endDate: end,
        annualBaselineUsd: "120000.00",
        owner: "Alice",
        referenceIndex: "CPI-U",
        sourceSystem: SOURCE,
        sourceExternalId: `${RUN}-full`,
      },
      {
        id: cNoBaseline,
        orgId,
        supplierId: supplierForContracts,
        contractNumber: `${RUN}-NB`,
        title: `${RUN} no-baseline`,
        startDate: start,
        endDate: end,
        // annualBaselineUsd omitted → null
        owner: "Bob",
        referenceIndex: "PPI",
        sourceSystem: SOURCE,
        sourceExternalId: `${RUN}-nb`,
      },
      {
        // 0 (or <=0) baseline is treated as missing by the route's
        // OR-with-numeric-cast guard. Pinning this branch so a regression
        // that drops the `<= 0` arm gets caught.
        id: cZeroBaseline,
        orgId,
        supplierId: supplierForContracts,
        contractNumber: `${RUN}-ZB`,
        title: `${RUN} zero-baseline`,
        startDate: start,
        endDate: end,
        annualBaselineUsd: "0",
        owner: "Carol",
        referenceIndex: "PPI",
        sourceSystem: SOURCE,
        sourceExternalId: `${RUN}-zb`,
      },
      {
        id: cNoOwner,
        orgId,
        supplierId: supplierForContracts,
        contractNumber: `${RUN}-NO`,
        title: `${RUN} no-owner`,
        startDate: start,
        endDate: end,
        annualBaselineUsd: "50000.00",
        owner: "", // empty string — also "missing" per the route
        referenceIndex: "PPI",
        sourceSystem: SOURCE,
        sourceExternalId: `${RUN}-no`,
      },
      {
        id: cNoRefIndex,
        orgId,
        supplierId: supplierForContracts,
        contractNumber: `${RUN}-NR`,
        title: `${RUN} no-refindex`,
        startDate: start,
        endDate: end,
        annualBaselineUsd: "50000.00",
        owner: "Dan",
        // referenceIndex omitted → null
        sourceSystem: SOURCE,
        sourceExternalId: `${RUN}-nr`,
      },
      {
        // Cross-tenant guard: missing every field, but in another org.
        id: cOtherTenant,
        orgId: otherOrgId,
        supplierId: supplierForOtherTenant,
        contractNumber: `${RUN}-X`,
        title: `${RUN} other-tenant`,
        startDate: start,
        endDate: end,
        // annualBaselineUsd, owner, referenceIndex omitted → all null
        sourceSystem: SOURCE,
        sourceExternalId: `${RUN}-x`,
      },
    ];
    await db.insert(contractsTable).values(contractRows);
  });

  after(async () => {
    await db
      .delete(contractsTable)
      .where(
        inArray(contractsTable.id, [
          cFull,
          cNoBaseline,
          cZeroBaseline,
          cNoOwner,
          cNoRefIndex,
          cOtherTenant,
        ]),
      );
    await db
      .delete(suppliersTable)
      .where(
        inArray(suppliersTable.id, [
          supBoth,
          supNoCurrency,
          supEmptyCurrency,
          supNoTerms,
          supOtherTenant,
          supplierForContracts,
          supplierForOtherTenant,
        ]),
      );
    await db.delete(orgsTable).where(inArray(orgsTable.id, [orgId, otherOrgId]));
  });

  // ─── Suppliers ──────────────────────────────────────────────────────────

  it("GET /suppliers?missing=billing_currency catches null and '' values", async () => {
    await withServer(async (baseUrl) => {
      const r = await getJson<{ id: string }>(
        baseUrl,
        "/api/suppliers",
        orgId,
        { search: RUN, missing: "billing_currency" },
      );
      assert.equal(r.status, 200);
      const ids = r.json.items.map((s) => s.id).sort();
      assert.deepEqual(
        ids,
        [supNoCurrency, supEmptyCurrency].sort(),
        "missing=billing_currency must include both null and '' rows and exclude populated ones",
      );
    });
  });

  it("GET /suppliers?missing=payment_terms_days catches null values only", async () => {
    await withServer(async (baseUrl) => {
      const r = await getJson<{ id: string }>(
        baseUrl,
        "/api/suppliers",
        orgId,
        { search: RUN, missing: "payment_terms_days" },
      );
      assert.equal(r.status, 200);
      const ids = r.json.items.map((s) => s.id).sort();
      assert.deepEqual(ids, [supNoTerms].sort());
    });
  });

  it("GET /suppliers?missing=… does not leak rows from another tenant", async () => {
    await withServer(async (baseUrl) => {
      const r = await getJson<{ id: string }>(
        baseUrl,
        "/api/suppliers",
        orgId,
        { search: RUN, missing: "billing_currency" },
      );
      assert.equal(r.status, 200);
      assert.ok(
        !r.json.items.some((s) => s.id === supOtherTenant),
        "orgId's missing-currency list must not include the other tenant's row",
      );
    });
  });

  it("GET /suppliers ignores unknown ?missing= values (back-compat contract)", async () => {
    // Per the comment in suppliers.ts, unknown values are intentionally
    // ignored so that adding a new readiness check doesn't 400 the list
    // page during a staggered FE/BE rollout. Pin that contract so a
    // future Zod-strict refactor at least has to update this test.
    await withServer(async (baseUrl) => {
      const r = await getJson<{ id: string }>(
        baseUrl,
        "/api/suppliers",
        orgId,
        { search: RUN, missing: "definitely-not-a-real-field" },
      );
      assert.equal(r.status, 200);
      const ids = r.json.items.map((s) => s.id).sort();
      assert.deepEqual(
        ids,
        [
          supBoth,
          supNoCurrency,
          supEmptyCurrency,
          supNoTerms,
          // The contracts-side supplier fixture also has the RUN
          // prefix in its name, so it lands in the same search bucket.
          supplierForContracts,
        ].sort(),
      );
    });
  });

  // ─── Contracts ──────────────────────────────────────────────────────────

  it("GET /contracts?missing=annual_baseline_usd catches null and <=0 values", async () => {
    await withServer(async (baseUrl) => {
      const r = await getJson<{ id: string }>(
        baseUrl,
        "/api/contracts",
        orgId,
        { search: RUN, missing: "annual_baseline_usd" },
      );
      assert.equal(r.status, 200);
      const ids = r.json.items.map((c) => c.id).sort();
      assert.deepEqual(
        ids,
        [cNoBaseline, cZeroBaseline].sort(),
        "missing=annual_baseline_usd must include null AND <=0 rows",
      );
    });
  });

  it("GET /contracts?missing=owner catches null and '' values", async () => {
    await withServer(async (baseUrl) => {
      const r = await getJson<{ id: string }>(
        baseUrl,
        "/api/contracts",
        orgId,
        { search: RUN, missing: "owner" },
      );
      assert.equal(r.status, 200);
      const ids = r.json.items.map((c) => c.id).sort();
      assert.deepEqual(ids, [cNoOwner].sort());
    });
  });

  it("GET /contracts?missing=reference_index catches null values", async () => {
    await withServer(async (baseUrl) => {
      const r = await getJson<{ id: string }>(
        baseUrl,
        "/api/contracts",
        orgId,
        { search: RUN, missing: "reference_index" },
      );
      assert.equal(r.status, 200);
      const ids = r.json.items.map((c) => c.id).sort();
      assert.deepEqual(ids, [cNoRefIndex].sort());
    });
  });

  it("GET /contracts?missing=… does not leak rows from another tenant", async () => {
    await withServer(async (baseUrl) => {
      const r = await getJson<{ id: string }>(
        baseUrl,
        "/api/contracts",
        orgId,
        { search: RUN, missing: "owner" },
      );
      assert.equal(r.status, 200);
      assert.ok(
        !r.json.items.some((c) => c.id === cOtherTenant),
        "orgId's missing-owner list must not include the other tenant's row",
      );
    });
  });

  it("GET /contracts ignores unknown ?missing= values (back-compat contract)", async () => {
    // Same reasoning as the suppliers route: unknown values are
    // silently ignored so adding a new readiness check never 400s the
    // existing list page mid-deploy. Pinning the contract.
    await withServer(async (baseUrl) => {
      const r = await getJson<{ id: string }>(
        baseUrl,
        "/api/contracts",
        orgId,
        { search: RUN, missing: "end_date" }, // explicitly excluded from the spec enum
      );
      assert.equal(r.status, 200);
      const ids = r.json.items.map((c) => c.id).sort();
      assert.deepEqual(
        ids,
        [cFull, cNoBaseline, cZeroBaseline, cNoOwner, cNoRefIndex].sort(),
      );
    });
  });
});
