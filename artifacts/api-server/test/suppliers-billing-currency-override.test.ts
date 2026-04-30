/**
 * Integration test for `POST /suppliers/:id/billing-currency` (#55).
 *
 * Pins the contract that:
 *   1. A valid 3-letter ISO body persists `billing_currency`,
 *      `billing_currency_source = 'manual_override'`, and
 *      `billing_currency_confidence = 'high'`, and returns the new row.
 *   2. The body is normalised to upper-case (`eur` → `EUR`).
 *   3. Invalid bodies (non-string, wrong length, digits) → 400.
 *   4. A 2nd tenant's supplier id returns 404 (no cross-tenant writes).
 *   5. The returned shape uses the camelCase fields that the
 *      OpenAPI / orval-generated client consumes.
 *
 * Self-cleaning per existing test conventions.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";

// Opt into the dev-only `x-org-id` header path before importing the app.
process.env["NODE_ENV"] = process.env["NODE_ENV"] ?? "development";
process.env["ALLOW_DEV_TENANT_HEADER"] = "true";

import { eq, or } from "drizzle-orm";
import { db, orgsTable, suppliersTable } from "@workspace/db";
import app from "../src/app";

const RUN = `t55o-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
const SOURCE = "csv";

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

let orgA: string;
let orgB: string;
let supplierA: string;
let supplierB: string;

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

async function postOverride(
  baseUrl: string,
  orgId: string,
  supplierId: string,
  body: unknown,
): Promise<{ status: number; body: string }> {
  const r = await fetch(
    `${baseUrl}/api/suppliers/${supplierId}/billing-currency`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-org-id": orgId,
      },
      body: JSON.stringify(body),
    },
  );
  return { status: r.status, body: await r.text() };
}

describe("POST /suppliers/:id/billing-currency (#55)", () => {
  before(async () => {
    orgA = newId("org");
    orgB = newId("org");
    await db.insert(orgsTable).values({
      id: orgA,
      name: `${RUN} org A`,
      slug: `${RUN}-a`,
    });
    await db.insert(orgsTable).values({
      id: orgB,
      name: `${RUN} org B`,
      slug: `${RUN}-b`,
    });
    supplierA = newId("sup");
    supplierB = newId("sup");
    await db.insert(suppliersTable).values({
      id: supplierA,
      orgId: orgA,
      name: `${RUN} supplier A`,
      normalizedName: `${RUN} supplier a`,
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-supA`,
    });
    await db.insert(suppliersTable).values({
      id: supplierB,
      orgId: orgB,
      name: `${RUN} supplier B`,
      normalizedName: `${RUN} supplier b`,
      sourceSystem: SOURCE,
      sourceExternalId: `${RUN}-supB`,
    });
  });

  after(async () => {
    await db
      .delete(suppliersTable)
      .where(or(eq(suppliersTable.id, supplierA), eq(suppliersTable.id, supplierB)));
    await db
      .delete(orgsTable)
      .where(or(eq(orgsTable.id, orgA), eq(orgsTable.id, orgB)));
  });

  it("persists a valid override and returns the new row", async () => {
    await withServer(async (baseUrl) => {
      const r = await postOverride(baseUrl, orgA, supplierA, {
        billingCurrency: "eur",
      });
      assert.equal(r.status, 200, `body=${r.body}`);
      const json = JSON.parse(r.body) as Record<string, unknown>;
      assert.equal(json["billingCurrency"], "EUR");
      assert.equal(json["billingCurrencySource"], "manual_override");
      assert.equal(json["billingCurrencyConfidence"], "high");
      assert.equal(json["id"], supplierA);

      const [row] = await db
        .select({
          billingCurrency: suppliersTable.billingCurrency,
          billingCurrencySource: suppliersTable.billingCurrencySource,
          billingCurrencyConfidence: suppliersTable.billingCurrencyConfidence,
        })
        .from(suppliersTable)
        .where(eq(suppliersTable.id, supplierA));
      assert.ok(row);
      assert.equal(row.billingCurrency, "EUR");
      assert.equal(row.billingCurrencySource, "manual_override");
      assert.equal(row.billingCurrencyConfidence, "high");
    });
  });

  it("rejects malformed bodies with 400", async () => {
    await withServer(async (baseUrl) => {
      for (const bad of [
        { billingCurrency: "EU" }, // too short
        { billingCurrency: "EURO" }, // too long
        { billingCurrency: "E0R" }, // contains digit
        { billingCurrency: 42 }, // wrong type
        {}, // missing
      ]) {
        const r = await postOverride(baseUrl, orgA, supplierA, bad);
        assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(bad)}, got ${r.status} ${r.body}`);
      }
    });
  });

  it("returns 404 when org A tries to override org B's supplier", async () => {
    await withServer(async (baseUrl) => {
      const r = await postOverride(baseUrl, orgA, supplierB, {
        billingCurrency: "GBP",
      });
      assert.equal(r.status, 404, `body=${r.body}`);
      const [row] = await db
        .select({
          billingCurrency: suppliersTable.billingCurrency,
        })
        .from(suppliersTable)
        .where(eq(suppliersTable.id, supplierB));
      assert.equal(
        row?.billingCurrency ?? null,
        null,
        "supplierB billing currency must remain null after cross-tenant attempt",
      );
    });
  });
});
