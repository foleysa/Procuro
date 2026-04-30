/**
 * Route-level integration test for the onboarding state machine and
 * its audit telemetry. Drives the real Express app over loopback HTTP
 * (not the lib helpers) so the contract the wizard talks to is the
 * one under test — including JSON serialisation, dev-header tenant
 * resolution, RBAC gating, and audit-log emission.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";

// Opt into the dev-only x-org-id header path BEFORE importing the
// app — the tenant middleware reads NODE_ENV at module load.
process.env["NODE_ENV"] = process.env["NODE_ENV"] ?? "development";
process.env["ALLOW_DEV_TENANT_HEADER"] = "true";

import {
  db,
  orgsTable,
  onboardingStateTable,
  adminAuditLogTable,
  suppliersTable,
  paymentsTable,
  invoicesTable,
  poLinesTable,
  purchaseOrdersTable,
  contractsTable,
  itemsTable,
  categoriesTable,
} from "@workspace/db";
import { and, eq, inArray, like } from "drizzle-orm";
import app from "../src/app";

const RUN = `t122r-${randomUUID().slice(0, 8)}`;
const ORG_ID = `org-${RUN}`;

interface Captured {
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

async function getJson(base: string, path: string): Promise<Captured> {
  const r = await fetch(`${base}${path}`, {
    headers: { "x-org-id": ORG_ID },
  });
  return { status: r.status, body: await r.text() };
}

async function patchJson(
  base: string,
  path: string,
  body: unknown,
): Promise<Captured> {
  const r = await fetch(`${base}${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-org-id": ORG_ID },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.text() };
}

async function postEmpty(base: string, path: string): Promise<Captured> {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "x-org-id": ORG_ID },
  });
  return { status: r.status, body: await r.text() };
}

async function deleteEmpty(base: string, path: string): Promise<Captured> {
  const r = await fetch(`${base}${path}`, {
    method: "DELETE",
    headers: { "x-org-id": ORG_ID },
  });
  return { status: r.status, body: await r.text() };
}

interface OnboardingDto {
  currentStep: string;
  completedSteps: Array<{ step: string; completedAt: string }>;
  dismissed: boolean;
  completed: boolean;
  dismissedAt: string | null;
  completedAt: string | null;
}

describe("onboarding routes — state machine + audit telemetry", () => {
  before(async () => {
    await db.insert(orgsTable).values({
      id: ORG_ID,
      name: `${RUN} Route Org`,
      slug: `${RUN}-org`,
    });
  });

  after(async () => {
    const safe = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch {
        /* swallow */
      }
    };
    await safe(
      db
        .delete(adminAuditLogTable)
        .where(eq(adminAuditLogTable.orgId, ORG_ID)),
    );
    await safe(
      db
        .delete(onboardingStateTable)
        .where(eq(onboardingStateTable.orgId, ORG_ID)),
    );
    await safe(db.delete(paymentsTable).where(eq(paymentsTable.orgId, ORG_ID)));
    await safe(db.delete(invoicesTable).where(eq(invoicesTable.orgId, ORG_ID)));
    await safe(db.delete(poLinesTable).where(eq(poLinesTable.orgId, ORG_ID)));
    await safe(
      db
        .delete(purchaseOrdersTable)
        .where(eq(purchaseOrdersTable.orgId, ORG_ID)),
    );
    await safe(
      db.delete(contractsTable).where(eq(contractsTable.orgId, ORG_ID)),
    );
    await safe(db.delete(itemsTable).where(eq(itemsTable.orgId, ORG_ID)));
    await safe(
      db.delete(suppliersTable).where(eq(suppliersTable.orgId, ORG_ID)),
    );
    await safe(
      db.delete(categoriesTable).where(eq(categoriesTable.orgId, ORG_ID)),
    );
    await safe(db.delete(orgsTable).where(eq(orgsTable.id, ORG_ID)));
  });

  it("GET initialises the row and emits a step_started audit event on first touch", async () => {
    await withServer(async (base) => {
      const res = await getJson(base, "/api/onboarding/state");
      assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.body}`);
      const body = JSON.parse(res.body) as OnboardingDto;
      assert.equal(body.currentStep, "welcome", "first-touch defaults to welcome");
      assert.equal(body.dismissed, false);
      assert.equal(body.completed, false);
    });

    // Audit row must exist for the first GET.
    const audits = await db
      .select()
      .from(adminAuditLogTable)
      .where(
        and(
          eq(adminAuditLogTable.orgId, ORG_ID),
          eq(adminAuditLogTable.action, "onboarding.step_started"),
        ),
      );
    assert.ok(audits.length >= 1, "first GET must emit step_started");
    const meta = audits[0]!.metadata as Record<string, unknown>;
    assert.equal(meta["firstTouch"], true);
  });

  it("GET on an existing row does NOT re-emit step_started", async () => {
    const before = await db
      .select()
      .from(adminAuditLogTable)
      .where(
        and(
          eq(adminAuditLogTable.orgId, ORG_ID),
          eq(adminAuditLogTable.action, "onboarding.step_started"),
        ),
      );
    await withServer(async (base) => {
      const res = await getJson(base, "/api/onboarding/state");
      assert.equal(res.status, 200);
    });
    const after = await db
      .select()
      .from(adminAuditLogTable)
      .where(
        and(
          eq(adminAuditLogTable.orgId, ORG_ID),
          eq(adminAuditLogTable.action, "onboarding.step_started"),
        ),
      );
    assert.equal(
      after.length,
      before.length,
      "subsequent GETs must NOT re-emit step_started",
    );
  });

  it("PATCH advances current step, records completion + step_completed/step_started events", async () => {
    await withServer(async (base) => {
      const res = await patchJson(base, "/api/onboarding/state", {
        currentStep: "bring_data",
        completedStep: "welcome",
      });
      assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.body}`);
      const body = JSON.parse(res.body) as OnboardingDto;
      assert.equal(body.currentStep, "bring_data");
      assert.ok(
        body.completedSteps.some((c) => c.step === "welcome"),
        "welcome must be in completedSteps",
      );
    });

    const events = await db
      .select()
      .from(adminAuditLogTable)
      .where(
        and(
          eq(adminAuditLogTable.orgId, ORG_ID),
          inArray(adminAuditLogTable.action, [
            "onboarding.step_completed",
            "onboarding.step_started",
          ]),
        ),
      );
    assert.ok(
      events.some(
        (e) =>
          e.action === "onboarding.step_completed" &&
          (e.metadata as Record<string, unknown>)["step"] === "welcome",
      ),
      "step_completed for welcome must have been emitted",
    );
    assert.ok(
      events.some(
        (e) =>
          e.action === "onboarding.step_started" &&
          (e.metadata as Record<string, unknown>)["step"] === "bring_data",
      ),
      "step_started for bring_data must have been emitted",
    );
  });

  it("PATCH with skipped:true emits step_skipped instead of step_completed", async () => {
    await withServer(async (base) => {
      const res = await patchJson(base, "/api/onboarding/state", {
        completedStep: "map_categories",
        skipped: true,
      });
      assert.equal(res.status, 200);
    });
    const skipped = await db
      .select()
      .from(adminAuditLogTable)
      .where(
        and(
          eq(adminAuditLogTable.orgId, ORG_ID),
          eq(adminAuditLogTable.action, "onboarding.step_skipped"),
          eq(adminAuditLogTable.targetLabel, "map_categories"),
        ),
      );
    assert.equal(skipped.length, 1, "exactly one skipped event for map_categories");
  });

  it("PATCH dismissed:true emits onboarding.dismissed once and is idempotent", async () => {
    await withServer(async (base) => {
      const r1 = await patchJson(base, "/api/onboarding/state", {
        dismissed: true,
      });
      assert.equal(r1.status, 200);
      const body1 = JSON.parse(r1.body) as OnboardingDto;
      assert.equal(body1.dismissed, true);
      assert.ok(body1.dismissedAt, "dismissedAt must be set");

      // Calling again should NOT emit a second event because the row is
      // already dismissed.
      const r2 = await patchJson(base, "/api/onboarding/state", {
        dismissed: true,
      });
      assert.equal(r2.status, 200);
    });

    const dismissed = await db
      .select()
      .from(adminAuditLogTable)
      .where(
        and(
          eq(adminAuditLogTable.orgId, ORG_ID),
          eq(adminAuditLogTable.action, "onboarding.dismissed"),
        ),
      );
    assert.equal(
      dismissed.length,
      1,
      `dismiss event must be emitted exactly once, saw ${dismissed.length}`,
    );
  });

  it("PATCH completed:true marks the row complete and emits onboarding.completed", async () => {
    await withServer(async (base) => {
      // Un-dismiss first so completion is the next state change.
      await patchJson(base, "/api/onboarding/state", { dismissed: false });
      const res = await patchJson(base, "/api/onboarding/state", {
        completed: true,
      });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body) as OnboardingDto;
      assert.equal(body.completed, true);
      assert.equal(body.currentStep, "completed");
      assert.ok(
        body.completedSteps.some((c) => c.step === "completed"),
        "completed step must be in completedSteps",
      );
    });

    const completed = await db
      .select()
      .from(adminAuditLogTable)
      .where(
        and(
          eq(adminAuditLogTable.orgId, ORG_ID),
          eq(adminAuditLogTable.action, "onboarding.completed"),
        ),
      );
    assert.equal(
      completed.length,
      1,
      "complete event must be emitted exactly once",
    );
  });

  it("POST sample-data installs sentinel rows + emits onboarding.sample_data_installed", async () => {
    await withServer(async (base) => {
      const res = await postEmpty(base, "/api/onboarding/sample-data");
      assert.equal(res.status, 200, `got ${res.status}: ${res.body}`);
      const body = JSON.parse(res.body) as { installed: boolean; counts: Record<string, number> };
      assert.equal(body.installed, true);
      assert.ok(body.counts["suppliers"]! > 0);
    });

    const events = await db
      .select()
      .from(adminAuditLogTable)
      .where(
        and(
          eq(adminAuditLogTable.orgId, ORG_ID),
          eq(adminAuditLogTable.action, "onboarding.sample_data_installed"),
        ),
      );
    assert.equal(events.length, 1, "install event must be emitted once");
  });

  it("DELETE sample-data removes rows + emits onboarding.sample_data_removed", async () => {
    await withServer(async (base) => {
      const res = await deleteEmpty(base, "/api/onboarding/sample-data");
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body) as { removed: boolean };
      assert.equal(body.removed, true);
    });

    const events = await db
      .select()
      .from(adminAuditLogTable)
      .where(
        and(
          eq(adminAuditLogTable.orgId, ORG_ID),
          eq(adminAuditLogTable.action, "onboarding.sample_data_removed"),
        ),
      );
    assert.equal(events.length, 1, "remove event must be emitted once");
  });

  it("readiness route scoped to the test org returns the 12 levers", async () => {
    await withServer(async (base) => {
      const res = await getJson(base, "/api/readiness");
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body) as {
        overallScore: number;
        levers: Array<{ leverId: string }>;
        hasIngestedData: boolean;
      };
      assert.equal(
        body.levers.length,
        12,
        `expected 12 levers, got ${body.levers.length}`,
      );
      // After installing sample data we have ingested data; after
      // removal the flag flips back. Either way the response shape
      // must be intact.
      assert.equal(typeof body.hasIngestedData, "boolean");
      assert.ok(typeof body.overallScore === "number");
    });

    // Quiet a noisy follow-on assertion: silence unused import.
    void like;
  });
});
