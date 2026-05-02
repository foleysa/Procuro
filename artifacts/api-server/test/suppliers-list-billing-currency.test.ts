// Integration test for GET /suppliers exposing billingCurrencySource +
// billingCurrencyConfidence on each row, plus the ?confidence= filter.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";

process.env["NODE_ENV"] = process.env["NODE_ENV"] ?? "development";
process.env["ALLOW_DEV_TENANT_HEADER"] = "true";

import { inArray } from "drizzle-orm";
import { db, orgsTable, suppliersTable } from "@workspace/db";
import app from "../src/app";

const RUN = `t139l-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
const SOURCE = "csv";

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

let orgA: string;
let orgB: string;
let supHigh: string;
let supMedium: string;
let supLow: string;
let supNoCurrency: string;
let supOtherTenant: string;

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

type SupplierItem = {
  id: string;
  billingCurrency: string | null;
  billingCurrencySource: string | null;
  billingCurrencyConfidence: string | null;
};

type SupplierListJson = {
  items: SupplierItem[];
  nextCursor: string | null;
};

async function getList(
  baseUrl: string,
  orgId: string,
  query: Record<string, string> = {},
): Promise<{ status: number; json: SupplierListJson }> {
  const qs = new URLSearchParams(query).toString();
  const url = `${baseUrl}/api/suppliers${qs ? `?${qs}` : ""}`;
  const r = await fetch(url, { headers: { "x-org-id": orgId } });
  return { status: r.status, json: (await r.json()) as SupplierListJson };
}

describe("GET /suppliers — billing-currency confidence (#139)", () => {
  // Isolation strategy (#252 audit): two fresh orgs are minted per
  // file run via `newId("org")` and torn down in `after()` (cascade
  // FKs sweep child supplier rows). Every list assertion is filtered
  // by `?search=${RUN}` and matched against the captured supplier
  // IDs, so org-wide aggregates from sibling tests cannot contaminate
  // this suite even when run in parallel.
  before(async () => {
    orgA = newId("org");
    orgB = newId("org");
    await db.insert(orgsTable).values([
      { id: orgA, name: `${RUN} org A`, slug: `${RUN}-a` },
      { id: orgB, name: `${RUN} org B`, slug: `${RUN}-b` },
    ]);

    supHigh = newId("sup");
    supMedium = newId("sup");
    supLow = newId("sup");
    supNoCurrency = newId("sup");
    supOtherTenant = newId("sup");

    await db.insert(suppliersTable).values([
      {
        id: supHigh,
        orgId: orgA,
        name: `${RUN} high`,
        normalizedName: `${RUN} high`,
        sourceSystem: SOURCE,
        sourceExternalId: `${RUN}-h`,
        billingCurrency: "EUR",
        billingCurrencySource: "country",
        billingCurrencyConfidence: "high",
      },
      {
        id: supMedium,
        orgId: orgA,
        name: `${RUN} medium`,
        normalizedName: `${RUN} medium`,
        sourceSystem: SOURCE,
        sourceExternalId: `${RUN}-m`,
        billingCurrency: "USD",
        billingCurrencySource: "invoice_symbol",
        billingCurrencyConfidence: "medium",
      },
      {
        id: supLow,
        orgId: orgA,
        name: `${RUN} low`,
        normalizedName: `${RUN} low`,
        sourceSystem: SOURCE,
        sourceExternalId: `${RUN}-l`,
        billingCurrency: "USD",
        billingCurrencySource: "country_dollarized",
        billingCurrencyConfidence: "low",
      },
      {
        id: supNoCurrency,
        orgId: orgA,
        name: `${RUN} none`,
        normalizedName: `${RUN} none`,
        sourceSystem: SOURCE,
        sourceExternalId: `${RUN}-n`,
      },
      {
        id: supOtherTenant,
        orgId: orgB,
        name: `${RUN} cross-tenant low`,
        normalizedName: `${RUN} cross-tenant low`,
        sourceSystem: SOURCE,
        sourceExternalId: `${RUN}-x`,
        billingCurrency: "USD",
        billingCurrencySource: "country_dollarized",
        billingCurrencyConfidence: "low",
      },
    ]);
  });

  after(async () => {
    await db
      .delete(suppliersTable)
      .where(
        inArray(suppliersTable.id, [
          supHigh,
          supMedium,
          supLow,
          supNoCurrency,
          supOtherTenant,
        ]),
      );
    await db.delete(orgsTable).where(inArray(orgsTable.id, [orgA, orgB]));
  });

  it("includes billingCurrencySource and billingCurrencyConfidence on each row", async () => {
    await withServer(async (baseUrl) => {
      const r = await getList(baseUrl, orgA, { search: RUN });
      assert.equal(r.status, 200);
      const byId = Object.fromEntries(r.json.items.map((s) => [s.id, s]));
      assert.equal(byId[supHigh]?.billingCurrencySource, "country");
      assert.equal(byId[supHigh]?.billingCurrencyConfidence, "high");
      assert.equal(byId[supMedium]?.billingCurrencySource, "invoice_symbol");
      assert.equal(byId[supMedium]?.billingCurrencyConfidence, "medium");
      assert.equal(byId[supLow]?.billingCurrencySource, "country_dollarized");
      assert.equal(byId[supLow]?.billingCurrencyConfidence, "low");
      assert.equal(byId[supNoCurrency]?.billingCurrencySource, null);
      assert.equal(byId[supNoCurrency]?.billingCurrencyConfidence, null);
    });
  });

  it("?confidence=low narrows to low-confidence rows and excludes nulls", async () => {
    await withServer(async (baseUrl) => {
      const r = await getList(baseUrl, orgA, {
        search: RUN,
        confidence: "low",
      });
      assert.equal(r.status, 200);
      const ids = r.json.items.map((s) => s.id).sort();
      assert.deepEqual(ids, [supLow].sort(), "only the low-confidence org-A row should be returned");
    });
  });

  it("?confidence=high returns only the high-confidence row", async () => {
    await withServer(async (baseUrl) => {
      const r = await getList(baseUrl, orgA, {
        search: RUN,
        confidence: "high",
      });
      assert.equal(r.status, 200);
      const ids = r.json.items.map((s) => s.id);
      assert.deepEqual(ids, [supHigh]);
    });
  });

  it("ignores unknown confidence values rather than 400ing", async () => {
    await withServer(async (baseUrl) => {
      const r = await getList(baseUrl, orgA, {
        search: RUN,
        confidence: "definitely-not-a-real-level",
      });
      assert.equal(r.status, 200);
      const ids = r.json.items.map((s) => s.id).sort();
      assert.deepEqual(
        ids,
        [supHigh, supMedium, supLow, supNoCurrency].sort(),
      );
    });
  });

  it("?confidence=low does not leak rows from another tenant", async () => {
    await withServer(async (baseUrl) => {
      const r = await getList(baseUrl, orgA, {
        search: RUN,
        confidence: "low",
      });
      assert.equal(r.status, 200);
      assert.ok(
        !r.json.items.some((s) => s.id === supOtherTenant),
        "org-A list must not include org-B's low-confidence row",
      );
      // And the inverse — org-B sees only its own low row.
      const rb = await getList(baseUrl, orgB, {
        search: RUN,
        confidence: "low",
      });
      assert.equal(rb.status, 200);
      const ids = rb.json.items.map((s) => s.id);
      assert.deepEqual(ids, [supOtherTenant]);
    });
  });
});
