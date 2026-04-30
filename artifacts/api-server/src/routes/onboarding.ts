import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import {
  db,
  onboardingStateTable,
  type OnboardingStateRow,
  type OnboardingWizardStep,
  type CompletedStepEntry,
} from "@workspace/db";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";
import { requirePermission } from "../lib/rbac";
import {
  PatchOnboardingStateBody,
  GetOnboardingStateResponse,
  InstallSampleDataResponse,
} from "@workspace/api-zod";
import {
  loadSampleData,
  removeSampleData,
} from "../lib/onboarding/sample-data";
import { writeAdminAudit } from "../lib/admin-audit";

const router: IRouter = Router();

const SYSTEM_ACTOR = "system@procuro.ai";

function actorEmail(req: { actorEmail?: string | undefined }): string {
  const raw = req.actorEmail?.trim();
  return raw && raw.length > 0 ? raw.toLowerCase() : SYSTEM_ACTOR;
}

function serialize(row: OnboardingStateRow): unknown {
  return GetOnboardingStateResponse.parse({
    currentStep: row.currentStep,
    completedSteps: (row.completedSteps ?? []).map((c) => ({
      step: c.step,
      completedAt: new Date(c.completedAt).toISOString(),
    })),
    startedAt: row.startedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    dismissedAt: row.dismissedAt ? row.dismissedAt.toISOString() : null,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    dismissed: row.dismissedAt != null,
    completed: row.completedAt != null,
  });
}

async function loadOrInit(
  orgId: string,
  email: string,
): Promise<OnboardingStateRow> {
  const [existing] = await db
    .select()
    .from(onboardingStateTable)
    .where(
      and(
        eq(onboardingStateTable.orgId, orgId),
        eq(onboardingStateTable.userEmail, email),
      ),
    );
  if (existing) return existing;
  const [inserted] = await db
    .insert(onboardingStateTable)
    .values({ orgId, userEmail: email })
    .returning();
  if (!inserted) {
    throw new Error("Failed to materialise onboarding state row");
  }
  return inserted;
}

router.get("/onboarding/state", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const email = actorEmail(req);
  const existing = await db
    .select()
    .from(onboardingStateTable)
    .where(
      and(
        eq(onboardingStateTable.orgId, orgId),
        eq(onboardingStateTable.userEmail, email),
      ),
    )
    .limit(1);

  if (existing.length === 0) {
    // First-touch: materialise the row AND emit step_started for the
    // initial `welcome` step so CS sees a wizard-opened event in the
    // audit log even if the user bounces immediately.
    const [inserted] = await db
      .insert(onboardingStateTable)
      .values({ orgId, userEmail: email })
      .returning();
    if (!inserted) {
      throw new Error("Failed to materialise onboarding state row");
    }
    await writeAdminAudit({
      orgId,
      actor: email,
      action: "onboarding.step_started",
      targetLabel: inserted.currentStep,
      metadata: { step: inserted.currentStep, firstTouch: true },
    });
    res.json(serialize(inserted));
    return;
  }
  res.json(serialize(existing[0]!));
});

router.patch("/onboarding/state", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const email = actorEmail(req);
  const body = PatchOnboardingStateBody.parse(req.body);

  const current = await loadOrInit(orgId, email);

  const next: Partial<OnboardingStateRow> = { updatedAt: new Date() };
  let completedSteps: CompletedStepEntry[] = [
    ...(current.completedSteps ?? []),
  ];

  // Build the audit-event queue first; emit them all AFTER the DB
  // write succeeds so a failed update doesn't write a misleading
  // event into the audit log.
  type Audit = {
    action:
      | "onboarding.step_started"
      | "onboarding.step_completed"
      | "onboarding.step_skipped"
      | "onboarding.dismissed"
      | "onboarding.completed";
    label?: string;
    metadata?: Record<string, unknown>;
  };
  const events: Audit[] = [];

  if (body.currentStep !== undefined) {
    next.currentStep = body.currentStep as OnboardingWizardStep;
    if (body.currentStep !== current.currentStep) {
      events.push({
        action: "onboarding.step_started",
        label: body.currentStep,
        metadata: {
          step: body.currentStep,
          previousStep: current.currentStep,
        },
      });
    }
  }
  if (body.completedStep !== undefined) {
    const step = body.completedStep as OnboardingWizardStep;
    completedSteps = completedSteps.filter((c) => c.step !== step);
    completedSteps.push({ step, completedAt: new Date().toISOString() });
    next.completedSteps = completedSteps;
    events.push({
      action: body.skipped
        ? "onboarding.step_skipped"
        : "onboarding.step_completed",
      label: step,
      metadata: { step, skipped: body.skipped === true },
    });
  }
  if (body.dismissed !== undefined) {
    next.dismissedAt = body.dismissed ? new Date() : null;
    if (body.dismissed && current.dismissedAt == null) {
      events.push({
        action: "onboarding.dismissed",
        label: current.currentStep,
        metadata: { step: current.currentStep },
      });
    }
  }
  if (body.completed !== undefined) {
    if (body.completed) {
      next.completedAt = new Date();
      next.currentStep = "completed";
      // Record `completed` as a step too so the dashboard can detect it.
      if (!completedSteps.some((c) => c.step === "completed")) {
        completedSteps.push({
          step: "completed",
          completedAt: new Date().toISOString(),
        });
        next.completedSteps = completedSteps;
      }
      if (current.completedAt == null) {
        events.push({
          action: "onboarding.completed",
          label: "completed",
          metadata: {
            stepsCompleted: completedSteps.map((c) => c.step),
          },
        });
      }
    } else {
      next.completedAt = null;
    }
  }

  const [updated] = await db
    .update(onboardingStateTable)
    .set(next)
    .where(
      and(
        eq(onboardingStateTable.orgId, orgId),
        eq(onboardingStateTable.userEmail, email),
      ),
    )
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Onboarding state row vanished" });
    return;
  }

  // Best-effort: telemetry should never break the user-facing PATCH.
  // Log the failure for ops and move on.
  for (const ev of events) {
    try {
      await writeAdminAudit({
        orgId,
        actor: email,
        action: ev.action,
        targetLabel: ev.label ?? null,
        metadata: ev.metadata ?? {},
      });
    } catch (err) {
      req.log.warn(
        { err, action: ev.action },
        "onboarding audit write failed",
      );
    }
  }

  res.json(serialize(updated));
});

router.post(
  "/onboarding/sample-data",
  tenantMiddleware,
  requirePermission("settings:write"),
  async (req, res) => {
    const orgId = requireOrgId(req);
    const result = await loadSampleData({ orgId });
    if (result.installed) {
      try {
        await writeAdminAudit({
          orgId,
          actor: actorEmail(req),
          action: "onboarding.sample_data_installed",
          metadata: { counts: result.counts },
        });
      } catch (err) {
        req.log.warn({ err }, "sample-data install audit failed");
      }
    }
    res.json(
      InstallSampleDataResponse.parse({
        installed: result.installed,
        removed: false,
        counts: result.counts,
      }),
    );
  },
);

router.delete(
  "/onboarding/sample-data",
  tenantMiddleware,
  requirePermission("settings:write"),
  async (req, res) => {
    const orgId = requireOrgId(req);
    const result = await removeSampleData({ orgId });
    if (result.removed) {
      try {
        await writeAdminAudit({
          orgId,
          actor: actorEmail(req),
          action: "onboarding.sample_data_removed",
          metadata: { counts: result.counts },
        });
      } catch (err) {
        req.log.warn({ err }, "sample-data remove audit failed");
      }
    }
    res.json(
      InstallSampleDataResponse.parse({
        installed: false,
        removed: result.removed,
        counts: result.counts,
      }),
    );
  },
);

export default router;
