/**
 * Admin routing endpoints (task #213).
 *
 *   GET  /admin/routing/queue                 — list open unmapped strings
 *   POST /admin/routing/queue/:id/resolve     — operator maps a string
 *   GET  /admin/routing/canonical-codes       — codes available to map to
 *   GET  /admin/routing/health                — view drift verdict
 *
 * All endpoints are tenant-scoped (queue resolution only mutates the
 * caller's org's queue) and gated by `audit:read` for reads,
 * `settings:write` for resolve. Resolution is an org-admin operation
 * (Engine operators map their own tenant strings); platform admins
 * inherit `settings:write` as well via role permissions.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";
import { pool } from "@workspace/db";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";
import { requirePermission } from "../lib/rbac";
import {
  listOpenQueue,
  resolveQueueEntry,
  checkRoutingHealth,
  suggestCategoryMappings,
} from "../lib/intelligence/routing";
import { writeAdminAudit } from "../lib/admin-audit";
import {
  InvalidRequestError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
  TenantMismatchError,
} from "../lib/api-errors";

const router: IRouter = Router();

router.get(
  "/admin/routing/queue",
  tenantMiddleware,
  requirePermission("audit:read"),
  async (req, res) => {
    const orgId = requireOrgId(req);
    const limit = Math.min(
      Number.parseInt(String(req.query["limit"] ?? "100"), 10) || 100,
      500,
    );
    const rows = await listOpenQueue(orgId, limit);
    // Layer D — attach top-3 suggestions per row so operators can
    // one-click accept the most likely canonical code instead of
    // scrolling the flat dropdown. Computed in a single batched
    // trigram query at request time; no precompute or background job.
    const suggestionsByQueueId = await suggestCategoryMappings({
      orgId,
      queueIds: rows.map((r) => r.id),
    });
    const entries = rows.map((r) => ({
      ...r,
      suggestions: suggestionsByQueueId.get(r.id) ?? [],
    }));
    res.json({ entries });
  },
);

const ResolveBody = z.object({
  canonicalCode: z.string().min(1).max(64),
  scope: z.enum(["global", "tenant_scoped"]),
  /**
   * Operator's choice when responding to a previously-surfaced
   * collision. Omitted on the first attempt — the server will return
   * a 409 with the colliding row, the UI shows the modal, and the
   * second call repeats with `decision` set.
   */
  decision: z
    .enum([
      "accept_existing",
      "force_override",
      "escalate_to_global",
      "narrow_to_tenant",
    ])
    .optional(),
});

router.post(
  "/admin/routing/queue/:id/resolve",
  tenantMiddleware,
  requirePermission("settings:write"),
  async (req, res) => {
    const orgId = requireOrgId(req);
    const parsed = ResolveBody.safeParse(req.body);
    if (!parsed.success) {
      throw new InvalidRequestError("invalid_body", parsed.error.issues);
    }
    const queueId = String(req.params.id);
    // The resolver looks up the queue entry inside its own
    // transaction; we only need to confirm tenancy by re-fetching with
    // a tenant-scoped predicate before delegating.
    const owned = await pool.query<{ org_id: string }>(
      "SELECT org_id FROM unmapped_category_queue WHERE id = $1",
      [queueId],
    );
    if (owned.rows.length === 0) {
      throw new NotFoundError("not_found");
    }
    if (owned.rows[0]!.org_id !== orgId) {
      throw new TenantMismatchError("Resource belongs to a different tenant");
    }
    // Attribute the resolution to the acting operator's user id (the
    // RBAC middleware populates req.user). Falling back to the orgId
    // would mis-credit the resolution to the tenant rather than the
    // human operator and would make every resolve event in an org
    // indistinguishable in the audit log.
    const actingUserId =
      (req as { user?: { id?: string } }).user?.id ?? `unknown-user@${orgId}`;
    // Global synonym writes (creating a new global row, escalating a
    // tenant row to global, or force-overriding an existing global
    // row) affect every tenant. Only platform admins are permitted
    // those operations — org admins can only mutate their own
    // tenant_scoped synonyms.
    const callerCanWriteGlobal =
      req.rbac?.roles.includes("platform_admin") ?? false;
    try {
      const result = await resolveQueueEntry({
        queueId,
        canonicalCode: parsed.data.canonicalCode,
        scope: parsed.data.scope,
        resolvedBy: actingUserId,
        decision: parsed.data.decision,
        callerCanWriteGlobal,
      });
      if (result.kind === "collision") {
        throw new ConflictError("synonym_collision", { existing: result.existing });
      }
      try {
        await writeAdminAudit({
          orgId,
          actor: actingUserId,
          action: "taxonomy.synonym_resolve",
          targetId: result.registryId,
          targetLabel: parsed.data.canonicalCode,
          metadata: {
            queueId,
            canonicalCode: parsed.data.canonicalCode,
            scope: parsed.data.scope,
            decision: result.collisionDecision ?? null,
            reCategorizedOpportunityCount:
              result.reCategorizedOpportunityCount,
          },
        });
      } catch (auditErr) {
        req.log.warn({ err: auditErr }, "Failed to write admin audit row");
      }
      return res.json({
        ok: true,
        registryId: result.registryId,
        reCategorizedOpportunityCount: result.reCategorizedOpportunityCount,
        collisionDecision: result.collisionDecision,
      });
    } catch (err) {
      // The decision-validation guards inside resolveQueueEntry throw
      // when an operator submits e.g. `escalate_to_global` for a
      // request that wasn't tenant-scoped; surface that as a 400
      // rather than a 500 so the UI can show a coherent error.
      // Authorization failures (caller not a platform admin trying to
      // write a global row) are surfaced as 403.
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith("forbidden:")) {
        throw new ForbiddenError(message);
      }
      if (
        message.includes("escalate_to_global") ||
        message.includes("narrow_to_tenant")
      ) {
        throw new InvalidRequestError(message);
      }
      throw err;
    }
  },
);

router.get(
  "/admin/routing/canonical-codes",
  tenantMiddleware,
  requirePermission("audit:read"),
  async (_req, res) => {
    const { rows } = await pool.query<{ category_code: string }>(
      "SELECT DISTINCT category_code FROM category_bands ORDER BY category_code",
    );
    res.json({ codes: rows.map((r) => r.category_code) });
  },
);

router.get(
  "/admin/routing/health",
  tenantMiddleware,
  requirePermission("audit:read"),
  async (_req, res) => {
    const report = await checkRoutingHealth();
    res.json(report);
  },
);

export default router;
