/**
 * Integration tests for the tenant-scoped watched-issuers admin
 * surface and the loaders that back the SEC EDGAR / Companies House
 * collectors.
 *
 * Pins the contract that:
 *   1. POST /watched-issuers persists a row scoped to the active tenant
 *      and normalises CIK / Companies-House numbers (no duplicate
 *      "320193" vs "0000320193" rows).
 *   2. GET /watched-issuers returns only the active tenant's rows
 *      (cross-tenant rows must never leak).
 *   3. DELETE /watched-issuers/:id only deletes rows owned by the
 *      active tenant (a 2nd tenant guessing the id sees a 404).
 *   4. The collector loaders (`loadWatchedSecIssuers` /
 *      `loadWatchedCompaniesHouseNumbers`) read the union across
 *      tenants and de-dupe on identifier.
 *   5. `getActiveSecIssuers` / `getActiveCompaniesHouseNumbers` fall
 *      back to the seed list when no tenant rows exist.
 *   6. Re-posting the same identifier returns 409 (uniqueness via the
 *      `(orgId, source, identifier)` index).
 *
 * Prereqs: DATABASE_URL is set, schema pushed, and at least one org
 * row exists (the test uses the first two; if only one exists it
 * synthesises a second so the cross-tenant assertions can still run).
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

// Opt into the dev-only `x-org-id` header path before importing the
// app — the auth middleware reads NODE_ENV at module-import time.
process.env["NODE_ENV"] = process.env["NODE_ENV"] ?? "development";
process.env["ALLOW_DEV_TENANT_HEADER"] = "true";

import {
  db,
  orgsTable,
  watchedIssuersTable,
  pool,
} from "@workspace/db";
import { and, eq, like, inArray } from "drizzle-orm";
import app from "../src/app";
import {
  getActiveSecIssuers,
  loadWatchedSecIssuers,
  SEC_EDGAR_DEFAULT_ISSUERS,
} from "../src/lib/intelligence/collectors/sec-edgar";
import {
  COMPANIES_HOUSE_DEFAULT_NUMBERS,
  getActiveCompaniesHouseNumbers,
  loadWatchedCompaniesHouseNumbers,
} from "../src/lib/intelligence/collectors/companies-house";

const RUN_ID = `task109-${Date.now()}-${process.pid}`;

interface CapturedResponse {
  status: number;
  body: string;
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

async function getJson(
  baseUrl: string,
  path: string,
  orgId: string,
): Promise<CapturedResponse> {
  const r = await fetch(`${baseUrl}${path}`, {
    headers: { "x-org-id": orgId },
  });
  return { status: r.status, body: await r.text() };
}

async function postJson(
  baseUrl: string,
  path: string,
  orgId: string,
  body: unknown,
): Promise<CapturedResponse> {
  const r = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-org-id": orgId,
    },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.text() };
}

async function deleteRow(
  baseUrl: string,
  path: string,
  orgId: string,
): Promise<CapturedResponse> {
  const r = await fetch(`${baseUrl}${path}`, {
    method: "DELETE",
    headers: { "x-org-id": orgId },
  });
  return { status: r.status, body: await r.text() };
}

let orgA: string;
let orgB: string;
const createdOrgIds: string[] = [];

before(async () => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }
  const orgs = await db
    .select({ id: orgsTable.id })
    .from(orgsTable)
    .orderBy(orgsTable.createdAt)
    .limit(2);
  if (orgs.length === 0) {
    throw new Error(
      "No org rows exist. Seed the database before running this test.",
    );
  }
  orgA = orgs[0]!.id;
  if (orgs.length >= 2) {
    orgB = orgs[1]!.id;
  } else {
    // Synthesise a second org so the cross-tenant isolation assertions
    // still run on a single-org test fixture.
    orgB = `org_${RUN_ID}-b`;
    await db.insert(orgsTable).values({
      id: orgB,
      name: `Watched-Issuers Test Org ${RUN_ID}`,
      slug: `watched-issuers-test-${RUN_ID}`,
    });
    createdOrgIds.push(orgB);
  }
});

after(async () => {
  // Tear down only rows we created (filter on the run-id prefix
  // baked into both the supplier name and the notes field).
  await db
    .delete(watchedIssuersTable)
    .where(like(watchedIssuersTable.notes, `%${RUN_ID}%`));
  if (createdOrgIds.length > 0) {
    await db.delete(orgsTable).where(inArray(orgsTable.id, createdOrgIds));
  }
  await pool.end().catch(() => {});
});

test("POST /watched-issuers persists a tenant-scoped row and normalises CIK", async () => {
  await withServer(async (base) => {
    const res = await postJson(base, "/api/watched-issuers", orgA, {
      source: "sec_edgar",
      // Unpadded — the route normalises to "0000320193".
      identifier: "320193",
      name: `Apple Inc. ${RUN_ID}`,
      lei: "HWUPKR0MPOU8FGXBT394",
      ticker: "AAPL",
      notes: `created by ${RUN_ID}`,
    });
    assert.equal(res.status, 201, res.body);
    const created = JSON.parse(res.body) as {
      id: string;
      identifier: string;
      source: string;
    };
    assert.equal(created.identifier, "0000320193");
    assert.equal(created.source, "sec_edgar");

    // Re-posting the same logical identifier (different shape) returns 409.
    const dup = await postJson(base, "/api/watched-issuers", orgA, {
      source: "sec_edgar",
      identifier: "0000320193",
      name: `Apple alias ${RUN_ID}`,
      notes: `created by ${RUN_ID}`,
    });
    assert.equal(dup.status, 409, dup.body);
  });
});

test("POST /watched-issuers normalises Companies House numbers (zero-pad to 8)", async () => {
  await withServer(async (base) => {
    const res = await postJson(base, "/api/watched-issuers", orgA, {
      source: "companies_house",
      identifier: "6245", // BP P.L.C. without padding
      name: `BP P.L.C. ${RUN_ID}`,
      notes: `created by ${RUN_ID}`,
    });
    assert.equal(res.status, 201, res.body);
    const created = JSON.parse(res.body) as { identifier: string };
    assert.equal(created.identifier, "00006245");
  });
});

test("GET /watched-issuers returns only the active tenant's rows", async () => {
  await withServer(async (base) => {
    // Add a row to tenant B so we can assert tenant A doesn't see it.
    const created = await postJson(base, "/api/watched-issuers", orgB, {
      source: "sec_edgar",
      identifier: "789019",
      name: `Microsoft (orgB) ${RUN_ID}`,
      notes: `created by ${RUN_ID}`,
    });
    assert.equal(created.status, 201, created.body);

    const aRes = await getJson(base, "/api/watched-issuers", orgA);
    assert.equal(aRes.status, 200);
    const a = JSON.parse(aRes.body) as { items: Array<{ identifier: string; name: string }> };
    const aIdentifiers = a.items.map((i) => i.identifier);
    assert.ok(
      aIdentifiers.includes("0000320193"),
      `tenant A should see its own SEC row; got: ${aIdentifiers.join(",")}`,
    );
    assert.ok(
      !aIdentifiers.includes("0000789019"),
      "tenant A must NOT see tenant B's Microsoft row",
    );

    const bRes = await getJson(base, "/api/watched-issuers?source=sec_edgar", orgB);
    assert.equal(bRes.status, 200);
    const b = JSON.parse(bRes.body) as { items: Array<{ identifier: string }> };
    const bIdentifiers = b.items.map((i) => i.identifier);
    assert.ok(bIdentifiers.includes("0000789019"));
    assert.ok(
      !bIdentifiers.includes("0000320193"),
      "tenant B must NOT see tenant A's Apple row",
    );
  });
});

test("loadWatchedSecIssuers returns the union across tenants, de-duped on CIK", async () => {
  // Add an overlapping CIK on tenant B (Apple again) to confirm the
  // union dedupe works.
  await db.insert(watchedIssuersTable).values({
    id: `wi_${RUN_ID}-overlap`,
    orgId: orgB,
    source: "sec_edgar",
    identifier: "0000320193",
    name: `Apple (orgB) ${RUN_ID}`,
    notes: `created by ${RUN_ID}`,
  });

  const watched = await loadWatchedSecIssuers();
  const ciks = watched.map((w) => w.cik);
  assert.equal(
    new Set(ciks).size,
    ciks.length,
    `loadWatchedSecIssuers must dedupe on CIK; got ${ciks.join(",")}`,
  );
  assert.ok(ciks.includes("0000320193"), "Apple CIK should be in the union");
  assert.ok(ciks.includes("0000789019"), "Microsoft CIK should be in the union");
});

test("loadWatchedCompaniesHouseNumbers returns deduped union across tenants", async () => {
  await db.insert(watchedIssuersTable).values({
    id: `wi_${RUN_ID}-ch-overlap`,
    orgId: orgB,
    source: "companies_house",
    identifier: "00006245", // BP again
    name: `BP P.L.C. (orgB) ${RUN_ID}`,
    notes: `created by ${RUN_ID}`,
  });

  const numbers = await loadWatchedCompaniesHouseNumbers();
  assert.equal(
    new Set(numbers).size,
    numbers.length,
    "company numbers must be unique after dedupe",
  );
  assert.ok(numbers.includes("00006245"));
});

test("getActiveSecIssuers prefers explicit override > tenant rows > seed", async () => {
  // 1. Override beats everything.
  const override = await getActiveSecIssuers([
    { cik: "0000040533", name: "Just General Mills" },
  ]);
  assert.equal(override.length, 1);
  assert.equal(override[0]!.cik, "0000040533");

  // 2. With tenant rows present, the seed isn't returned.
  const watched = await getActiveSecIssuers();
  const watchedCiks = watched.map((w) => w.cik);
  // Tenant rows include 320193 + 789019 from earlier in the suite,
  // and the seed includes Caterpillar (0000018230). We expect the
  // tenant rows but NOT the seed-only Caterpillar entry.
  assert.ok(watchedCiks.includes("0000320193"));
  assert.ok(
    !watchedCiks.includes("0000018230"),
    "seed must NOT be merged when tenant rows exist",
  );
});

test("getActiveCompaniesHouseNumbers falls back to the seed when no tenant rows exist", async () => {
  // Strip every tenant row first.
  await db.delete(watchedIssuersTable).where(
    eq(watchedIssuersTable.source, "companies_house"),
  );

  const fallback = await getActiveCompaniesHouseNumbers();
  // The seed should now be the active list.
  assert.equal(
    new Set(fallback).size,
    new Set(COMPANIES_HOUSE_DEFAULT_NUMBERS.map((n) => n)).size,
  );
  for (const n of COMPANIES_HOUSE_DEFAULT_NUMBERS) {
    assert.ok(
      fallback.includes(n),
      `seed entry ${n} must appear in the fallback list`,
    );
  }
});

test("getActiveSecIssuers falls back to the seed when no tenant rows exist", async () => {
  await db.delete(watchedIssuersTable).where(
    eq(watchedIssuersTable.source, "sec_edgar"),
  );
  const fallback = await getActiveSecIssuers();
  assert.equal(fallback.length, SEC_EDGAR_DEFAULT_ISSUERS.length);
  const ciks = new Set(fallback.map((i) => i.cik));
  for (const seed of SEC_EDGAR_DEFAULT_ISSUERS) {
    assert.ok(ciks.has(seed.cik), `seed entry ${seed.cik} should appear`);
  }
});

test("POST /watched-issuers rejects malformed identifiers per source", async () => {
  await withServer(async (base) => {
    // SEC: non-numeric CIK normalises to "0000000000" (CIK 0) — must 400.
    const badSec = await postJson(base, "/api/watched-issuers", orgA, {
      source: "sec_edgar",
      identifier: "not-a-cik",
      name: `Bogus ${RUN_ID}`,
      notes: `created by ${RUN_ID}`,
    });
    assert.equal(badSec.status, 400, badSec.body);
    assert.match(badSec.body, /CIK/);

    // SEC: explicit zero CIK is also rejected.
    const zeroSec = await postJson(base, "/api/watched-issuers", orgA, {
      source: "sec_edgar",
      identifier: "0",
      name: `Zero ${RUN_ID}`,
      notes: `created by ${RUN_ID}`,
    });
    assert.equal(zeroSec.status, 400, zeroSec.body);

    // Companies House: wrong-shape (single letter prefix) — must 400.
    const badCh = await postJson(base, "/api/watched-issuers", orgA, {
      source: "companies_house",
      identifier: "X1234567",
      name: `Bogus CH ${RUN_ID}`,
      notes: `created by ${RUN_ID}`,
    });
    assert.equal(badCh.status, 400, badCh.body);
    assert.match(badCh.body, /Companies House/);

    // Companies House: SC-prefixed numbers ARE valid (Scottish reg).
    const scOk = await postJson(base, "/api/watched-issuers", orgA, {
      source: "companies_house",
      identifier: "SC123456",
      name: `Scottish Co ${RUN_ID}`,
      notes: `created by ${RUN_ID}`,
    });
    assert.equal(scOk.status, 201, scOk.body);
    const scCreated = JSON.parse(scOk.body) as { identifier: string };
    assert.equal(scCreated.identifier, "SC123456");
  });
});

test("DELETE /watched-issuers/:id only removes rows the tenant owns", async () => {
  await withServer(async (base) => {
    // Add one for tenant A.
    const aCreate = await postJson(base, "/api/watched-issuers", orgA, {
      source: "sec_edgar",
      identifier: "1018724",
      name: `Amazon ${RUN_ID}`,
      notes: `created by ${RUN_ID}`,
    });
    assert.equal(aCreate.status, 201, aCreate.body);
    const { id } = JSON.parse(aCreate.body) as { id: string };

    // Tenant B trying to delete tenant A's row — must 404, not 204.
    const bDelete = await deleteRow(base, `/api/watched-issuers/${id}`, orgB);
    assert.equal(bDelete.status, 404, bDelete.body);

    // Confirm the row is still there.
    const [stillThere] = await db
      .select()
      .from(watchedIssuersTable)
      .where(eq(watchedIssuersTable.id, id));
    assert.ok(stillThere, "row must survive a cross-tenant delete attempt");

    // Tenant A deletes their own row — succeeds with 204.
    const aDelete = await deleteRow(base, `/api/watched-issuers/${id}`, orgA);
    assert.equal(aDelete.status, 204);
    const after = await db
      .select()
      .from(watchedIssuersTable)
      .where(eq(watchedIssuersTable.id, id));
    assert.equal(after.length, 0, "row must be gone after owner-issued delete");
  });
});
