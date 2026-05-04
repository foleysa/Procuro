import { test, expect, type APIRequestContext } from "@playwright/test";
import {
  seedApproveOpportunity,
  seedRejectOpportunity,
  cleanup,
  closePool,
  type SeedResult,
} from "./seed";

const API_BASE = "/api";

function apiHeaders(orgId: string) {
  return {
    "x-org-id": orgId,
    "Content-Type": "application/json",
  };
}

async function fetchOpportunity(
  request: APIRequestContext,
  orgId: string,
  oppId: string,
) {
  const resp = await request.get(`${API_BASE}/opportunities/${oppId}`, {
    headers: apiHeaders(orgId),
  });
  expect(resp.ok()).toBeTruthy();
  return resp.json();
}

test.describe("Opportunity approval journey", () => {
  let seed: SeedResult;

  test.beforeAll(async () => {
    seed = await seedApproveOpportunity();
  });

  test.afterAll(async () => {
    await cleanup(seed);
    await closePool();
  });

  test("approve an opportunity via API and verify DB transitions", async ({
    request,
  }) => {
    await test.step("Verify opportunity starts in proposed/Identified state", async () => {
      const body = await fetchOpportunity(request, seed.orgId, seed.opportunityId);
      expect(body.status).toBe("proposed");
      expect(body.canonicalStage).toBe("Identified");
      expect(body.savingsType).toBe("Identified");
    });

    await test.step("Approve the opportunity via POST", async () => {
      const resp = await request.post(
        `${API_BASE}/opportunities/${seed.opportunityId}/approve`,
        {
          headers: apiHeaders(seed.orgId),
          data: {},
        },
      );
      expect(resp.ok()).toBeTruthy();
      const body = await resp.json();
      expect(body.status).toBe("approved");
      expect(body.canonicalStage).toBe("Awarded");
      expect(body.savingsType).toBe("Negotiated");
    });

    await test.step("Verify canonical_stage is Awarded and savings_type is Negotiated", async () => {
      const body = await fetchOpportunity(request, seed.orgId, seed.opportunityId);
      expect(body.canonicalStage).toBe("Awarded");
      expect(body.savingsType).toBe("Negotiated");
      expect(body.status).toBe("approved");
    });

    await test.step("Verify stage history has Identified → Awarded transition", async () => {
      const body = await fetchOpportunity(request, seed.orgId, seed.opportunityId);
      const history: Array<{ fromStage: string | null; toStage: string }> =
        body.stageHistory ?? [];
      const transition = history.find(
        (h) => h.fromStage === "Identified" && h.toStage === "Awarded",
      );
      expect(transition).toBeTruthy();
    });

    await test.step("Verify decisions table has an approve event", async () => {
      const body = await fetchOpportunity(request, seed.orgId, seed.opportunityId);
      const decisions: Array<{ eventType: string }> = body.decisions ?? [];
      const approveDecision = decisions.find((d) => d.eventType === "approve");
      expect(approveDecision).toBeTruthy();
    });
  });
});

test.describe("Opportunity rejection journey", () => {
  let seed: SeedResult;

  test.beforeAll(async () => {
    seed = await seedRejectOpportunity();
  });

  test.afterAll(async () => {
    await cleanup(seed);
    await closePool();
  });

  test("reject an opportunity with a reason code and verify DB transitions", async ({
    request,
  }) => {
    await test.step("Verify opportunity starts in proposed/Identified state", async () => {
      const body = await fetchOpportunity(request, seed.orgId, seed.opportunityId);
      expect(body.status).toBe("proposed");
      expect(body.canonicalStage).toBe("Identified");
    });

    await test.step("Reject the opportunity via POST with reason code", async () => {
      const resp = await request.post(
        `${API_BASE}/opportunities/${seed.opportunityId}/reject`,
        {
          headers: apiHeaders(seed.orgId),
          data: {
            reasonCode: "compliance_or_legal_block",
            reasonText: "E2E test rejection note",
          },
        },
      );
      expect(resp.ok()).toBeTruthy();
      const body = await resp.json();
      expect(body.status).toBe("rejected");
      expect(body.canonicalStage).toBe("Closed-No Action");
    });

    await test.step("Verify canonical_stage is Closed-No Action", async () => {
      const body = await fetchOpportunity(request, seed.orgId, seed.opportunityId);
      expect(body.canonicalStage).toBe("Closed-No Action");
      expect(body.status).toBe("rejected");
      expect(body.rejectedReasonCode).toBe("compliance_or_legal_block");
    });

    await test.step("Verify stage history records Identified → Closed-No Action", async () => {
      const body = await fetchOpportunity(request, seed.orgId, seed.opportunityId);
      const history: Array<{ fromStage: string | null; toStage: string }> =
        body.stageHistory ?? [];
      const transition = history.find(
        (h) =>
          h.fromStage === "Identified" && h.toStage === "Closed-No Action",
      );
      expect(transition).toBeTruthy();
    });

    await test.step("Verify decisions table has a reject event with reason code", async () => {
      const body = await fetchOpportunity(request, seed.orgId, seed.opportunityId);
      const decisions: Array<{
        eventType: string;
        rejectedReasonCode?: string;
      }> = body.decisions ?? [];
      const rejectDecision = decisions.find((d) => d.eventType === "reject");
      expect(rejectDecision).toBeTruthy();
      expect(rejectDecision!.rejectedReasonCode).toBe("compliance_or_legal_block");
    });
  });
});
