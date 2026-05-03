/**
 * Route-level tests for the watched-US-suppliers admin surface.
 *
 * Pins the contract that the watchlist UI cannot reach through to
 * canonical supplier master rows:
 *   1. GET /us-suppliers only returns rows whose `sourceSystem` is
 *      `admin` or `us_supplier_seed` — CSV-ingested rows stay hidden.
 *   2. DELETE /us-suppliers/:id refuses to remove a CSV-ingested
 *      supplier (404), even when the caller passes a real id from
 *      their own tenant. This guards against accidental cascade
 *      deletion of contracts/POs.
 *   3. DELETE happily removes admin-added watchlist rows.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env["NODE_ENV"] = process.env["NODE_ENV"] ?? "development";
process.env["ALLOW_DEV_TENANT_HEADER"] = "true";

import { db, orgsTable, suppliersTable, pool } from "@workspace/db";
import { inArray, eq } from "drizzle-orm";
import app from "../src/app";

const RUN_ID = `task261-route-${Date.now()}-${process.pid}`;
const ORG = `org-${RUN_ID}`;
const CSV_SUPPLIER_ID = `sup-${RUN_ID}-csv`;

interface Captured {
  status: number;
  body: string;
}

async function withServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  try {
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("expected AddressInfo");
    }
    return await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function req(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Captured> {
  const r = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: {
      "x-org-id": ORG,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.text() };
}

before(async () => {
  await db.insert(orgsTable).values({
    id: ORG,
    name: `US Suppliers Route ${RUN_ID}`,
    slug: `${ORG}-slug`,
    // Pre-stamp the seed marker so the seeder does NOT auto-inject
    // 20 rows when the route loader fires — this test is about the
    // admin lifecycle, not the seed.
    usSuppliersSeededAt: new Date(),
  });
  await db.insert(suppliersTable).values({
    id: CSV_SUPPLIER_ID,
    orgId: ORG,
    name: `${RUN_ID} CSV Master Co`,
    normalizedName: `${RUN_ID} csv master co`,
    countryCode: "US",
    sourceSystem: "csv",
    sourceExternalId: CSV_SUPPLIER_ID,
  });
});

after(async () => {
  await db.delete(suppliersTable).where(eq(suppliersTable.orgId, ORG));
  await db.delete(orgsTable).where(inArray(orgsTable.id, [ORG]));
  await pool.end().catch(() => {});
});

test("GET /us-suppliers hides canonical (csv) supplier rows", async () => {
  await withServer(async (baseUrl) => {
    const res = await req(baseUrl, "GET", "/us-suppliers");
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body) as { items: { id: string }[] };
    const ids = body.items.map((i) => i.id);
    assert.ok(
      !ids.includes(CSV_SUPPLIER_ID),
      "CSV-ingested supplier must NOT appear on the watchlist surface",
    );
  });
});

test("DELETE /us-suppliers/:id refuses to remove a csv supplier (404)", async () => {
  await withServer(async (baseUrl) => {
    const res = await req(baseUrl, "DELETE", `/us-suppliers/${CSV_SUPPLIER_ID}`);
    assert.equal(res.status, 404);
    const stillThere = await db
      .select({ id: suppliersTable.id })
      .from(suppliersTable)
      .where(eq(suppliersTable.id, CSV_SUPPLIER_ID));
    assert.equal(
      stillThere.length,
      1,
      "csv supplier row must survive a watchlist DELETE attempt",
    );
  });
});

test("POST then DELETE works for admin-added watchlist rows", async () => {
  await withServer(async (baseUrl) => {
    const created = await req(baseUrl, "POST", "/us-suppliers", {
      name: `${RUN_ID} Admin Added Co`,
    });
    assert.equal(created.status, 201);
    const { id } = JSON.parse(created.body) as { id: string };
    const removed = await req(baseUrl, "DELETE", `/us-suppliers/${id}`);
    assert.equal(removed.status, 204);
    const after = await db
      .select({ id: suppliersTable.id })
      .from(suppliersTable)
      .where(eq(suppliersTable.id, id));
    assert.equal(after.length, 0);
  });
});
