import { Router, type IRouter } from "express";
import {
  db,
  jobsTable,
  jobKindSettingsTable,
  type JobKind,
  type JobStatus,
} from "@workspace/db";
import { and, desc, eq, gte, isNull, or, type SQL } from "drizzle-orm";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";
import { requirePermission } from "../lib/rbac";
import {
  enqueueJob,
  requestJobCancellation,
  MAX_ATTEMPTS_BY_KIND,
  MAX_ATTEMPTS_LIMIT,
} from "../lib/jobs/queue";
import { redactJobPayload } from "../lib/jobs/redact-payload";

const router: IRouter = Router();

const jobKindAllow = new Set<JobKind>([
  "run_analysis_cycle",
  "ingest_csv",
  "ingest_mock_erp",
  "run_collector",
  "sync_erp_connection",
]);

/**
 * Job kinds that operators can configure from the System page. We
 * deliberately exclude `prune_jobs` — it's internal housekeeping with no
 * upstream API calls, so a tunable retry budget would just add UI noise.
 */
const configurableKinds: readonly JobKind[] = [
  "ingest_csv",
  "ingest_mock_erp",
  "run_analysis_cycle",
  "run_collector",
  "sync_erp_connection",
];
const configurableKindSet = new Set<JobKind>(configurableKinds);

const jobStatusAllow = new Set<JobStatus>([
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

function mapJob(r: typeof jobsTable.$inferSelect) {
  return {
    id: r.id,
    orgId: r.orgId,
    kind: r.kind,
    status: r.status,
    attempts: r.attempts,
    maxAttempts: r.maxAttempts,
    progress: r.progress,
    result: r.result ?? null,
    error: r.error,
    cancelRequested: r.cancelRequested,
    enqueuedAt: r.enqueuedAt,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    scheduledFor: r.scheduledFor,
  };
}

/**
 * Like `mapJob`, but also includes a defensively-redacted copy of the
 * job payload. Used by the job-detail endpoint and the failed-jobs
 * notification surface so admins can see *why* a job died (which CSV
 * row, which ERP query) without leaking credential-shaped fields.
 *
 * Listing endpoints intentionally use the lighter `mapJob` to keep
 * response sizes bounded.
 */
function mapJobWithPayload(r: typeof jobsTable.$inferSelect) {
  return {
    ...mapJob(r),
    payload: redactJobPayload(r.payload),
  };
}

router.get("/jobs", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const limit = Math.min(
    Math.max(parseInt((req.query["limit"] as string) ?? "50", 10) || 50, 1),
    200,
  );

  const filters: SQL[] = [
    or(eq(jobsTable.orgId, orgId), isNull(jobsTable.orgId)) as SQL,
  ];

  const kindParam = req.query["kind"];
  if (typeof kindParam === "string" && jobKindAllow.has(kindParam as JobKind)) {
    filters.push(eq(jobsTable.kind, kindParam as JobKind));
  }
  const statusParam = req.query["status"];
  if (
    typeof statusParam === "string" &&
    jobStatusAllow.has(statusParam as JobStatus)
  ) {
    filters.push(eq(jobsTable.status, statusParam as JobStatus));
  }

  const rows = await db
    .select()
    .from(jobsTable)
    .where(and(...filters))
    .orderBy(desc(jobsTable.enqueuedAt))
    .limit(limit);

  res.json(rows.map(mapJob));
});

// ---------------------------------------------------------------------------
// Per-kind retry budget configuration (System page)
//
// Settings are scoped per-tenant: each org sees and edits only its own
// overrides, and `enqueueJob` only consults the row matching the job's
// `orgId`. This matches the rest of the System page (recent jobs are
// already filtered by org) and prevents one tenant from changing
// another tenant's retry behaviour.
//
// `GET /jobs/settings` returns one entry per configurable job kind for
// the caller's org, with the effective retry budget — either the
// operator's per-tenant override from `job_kind_settings`, or the
// in-code default from `MAX_ATTEMPTS_BY_KIND` when no override exists.
// The `isOverride` flag tells the UI whether a row exists for this org
// so it can show "default" vs "custom".
//
// `PUT /jobs/settings/:kind` upserts an override for a single kind for
// the caller's org. The next `enqueueJob` call for that org (and only
// the next one — already-pending rows keep their per-row `max_attempts`
// value to avoid mid-flight surprises) will use the new value.
//
// IMPORTANT: these routes are declared BEFORE `/jobs/:id` so Express does
// not match `/jobs/settings` against the `:id` param.
// ---------------------------------------------------------------------------

router.get("/jobs/settings", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const overrides = await db
    .select()
    .from(jobKindSettingsTable)
    .where(eq(jobKindSettingsTable.orgId, orgId));
  const overrideByKind = new Map(overrides.map((r) => [r.kind, r] as const));

  const rows = configurableKinds.map((kind) => {
    const override = overrideByKind.get(kind);
    const defaultMaxAttempts = MAX_ATTEMPTS_BY_KIND[kind] ?? 3;
    const maxAttempts = override?.maxAttempts ?? defaultMaxAttempts;
    return {
      kind,
      maxAttempts,
      defaultMaxAttempts,
      isOverride: override !== undefined,
      updatedAt: override?.updatedAt ?? null,
      lastChangedBy: override?.lastChangedBy ?? null,
      lastChangedAt: override?.lastChangedAt ?? null,
    };
  });

  res.json(rows);
});

router.put("/jobs/settings/:kind", tenantMiddleware, requirePermission("settings:write"), async (req, res) => {
  const orgId = requireOrgId(req);
  const kind = String(req.params.kind ?? "") as JobKind;
  if (!configurableKindSet.has(kind)) {
    res.status(400).json({ error: `Unknown or non-configurable kind: ${kind}` });
    return;
  }

  const raw = (req.body as { maxAttempts?: unknown })?.maxAttempts;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    res.status(400).json({
      error: "maxAttempts must be an integer >= 1",
    });
    return;
  }
  if (n > MAX_ATTEMPTS_LIMIT) {
    res.status(400).json({
      error: `maxAttempts must be <= ${MAX_ATTEMPTS_LIMIT}`,
    });
    return;
  }

  const now = new Date();
  const actor = req.actorEmail ?? null;
  await db
    .insert(jobKindSettingsTable)
    .values({
      orgId,
      kind,
      maxAttempts: n,
      updatedAt: now,
      lastChangedBy: actor,
      lastChangedAt: now,
    })
    .onConflictDoUpdate({
      target: [jobKindSettingsTable.orgId, jobKindSettingsTable.kind],
      set: {
        maxAttempts: n,
        updatedAt: now,
        lastChangedBy: actor,
        lastChangedAt: now,
      },
    });

  req.log.info(
    { orgId, kind, maxAttempts: n, actor },
    "Updated per-tenant retry budget override",
  );

  const defaultMaxAttempts = MAX_ATTEMPTS_BY_KIND[kind] ?? 3;
  res.json({
    kind,
    maxAttempts: n,
    defaultMaxAttempts,
    isOverride: true,
    updatedAt: now,
    lastChangedBy: actor,
    lastChangedAt: now,
  });
});

// Clear an override and revert to the in-code default (#96).
router.delete("/jobs/settings/:kind", tenantMiddleware, requirePermission("settings:write"), async (req, res) => {
  const orgId = requireOrgId(req);
  const kind = String(req.params.kind ?? "") as JobKind;
  if (!configurableKindSet.has(kind)) {
    res.status(400).json({ error: `Unknown or non-configurable kind: ${kind}` });
    return;
  }

  await db
    .delete(jobKindSettingsTable)
    .where(
      and(
        eq(jobKindSettingsTable.orgId, orgId),
        eq(jobKindSettingsTable.kind, kind),
      ),
    );

  req.log.info(
    { orgId, kind, actor: req.actorEmail ?? null },
    "Cleared per-tenant retry budget override",
  );

  const defaultMaxAttempts = MAX_ATTEMPTS_BY_KIND[kind] ?? 3;
  res.json({
    kind,
    maxAttempts: defaultMaxAttempts,
    defaultMaxAttempts,
    isOverride: false,
    updatedAt: null,
    lastChangedBy: null,
    lastChangedAt: null,
  });
});

// ---------------------------------------------------------------------------
// Recently-failed jobs (#94 — admin notification surface)
//
// Powers the persistent "job failed permanently" banner in the Command
// Center. Returns the most recent permanently-failed jobs for the
// active tenant in the lookback window so the banner can render the
// failing kind / id / error / age without the operator having to dig
// through System & Jobs first.
//
// Window defaults to 24h to match the other "what needs your attention
// this morning" surfaces (Today page, dashboard); callers can tighten
// it via `?withinHours=`. Capped at 7 days to keep the query bounded.
//
// IMPORTANT: declared BEFORE `/jobs/:id` so Express does not match
// `/jobs/recently-failed` against the `:id` param.
// ---------------------------------------------------------------------------
router.get("/jobs/recently-failed", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);

  const withinHoursRaw = parseInt(
    String(req.query["withinHours"] ?? "24"),
    10,
  );
  const withinHours = Math.min(
    Math.max(Number.isFinite(withinHoursRaw) ? withinHoursRaw : 24, 1),
    24 * 7,
  );
  const cutoff = new Date(Date.now() - withinHours * 60 * 60 * 1000);

  const limitRaw = parseInt(String(req.query["limit"] ?? "20"), 10);
  const limit = Math.min(
    Math.max(Number.isFinite(limitRaw) ? limitRaw : 20, 1),
    100,
  );

  const rows = await db
    .select()
    .from(jobsTable)
    .where(
      and(
        or(
          eq(jobsTable.orgId, orgId),
          isNull(jobsTable.orgId),
        ) as SQL,
        eq(jobsTable.status, "failed"),
        gte(jobsTable.completedAt, cutoff),
      ),
    )
    .orderBy(desc(jobsTable.completedAt))
    .limit(limit);

  res.json({
    withinHours,
    count: rows.length,
    jobs: rows.map(mapJob),
  });
});

router.get("/jobs/:id", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const [row] = await db
    .select()
    .from(jobsTable)
    .where(
      and(
        eq(jobsTable.id, String(req.params.id)),
        or(eq(jobsTable.orgId, orgId), isNull(jobsTable.orgId)),
      ),
    );
  if (!row) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  // Detail view ships the redacted payload so the job-detail page can
  // show admins the actual input that triggered the failure without
  // leaking credential-shaped fields. The listing endpoint above
  // intentionally omits payloads to keep responses bounded.
  res.json(mapJobWithPayload(row));
});

router.post("/jobs/:id/retry", tenantMiddleware, requirePermission("ingest:write"), async (req, res) => {
  const orgId = requireOrgId(req);
  const [row] = await db
    .select()
    .from(jobsTable)
    .where(
      and(
        eq(jobsTable.id, String(req.params.id)),
        or(eq(jobsTable.orgId, orgId), isNull(jobsTable.orgId)),
      ),
    );
  if (!row) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  if (row.status !== "failed") {
    res.status(409).json({
      error: `Only failed jobs can be retried (current status: ${row.status})`,
    });
    return;
  }

  const job = await enqueueJob({
    kind: row.kind,
    orgId: row.orgId,
    payload: row.payload ?? {},
  });
  req.log.info(
    { originalJobId: row.id, retryJobId: job.id, kind: job.kind },
    "Retried failed job",
  );
  res.status(202).json({ jobId: job.id, status: job.status });
});

router.post("/jobs/:id/cancel", tenantMiddleware, requirePermission("ingest:write"), async (req, res) => {
  const orgId = requireOrgId(req);
  const id = String(req.params.id);
  const [row] = await db
    .select()
    .from(jobsTable)
    .where(
      and(
        eq(jobsTable.id, id),
        or(eq(jobsTable.orgId, orgId), isNull(jobsTable.orgId)),
      ),
    );
  if (!row) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  if (
    row.status === "succeeded" ||
    row.status === "failed" ||
    row.status === "cancelled"
  ) {
    res.status(409).json({
      error: `Job is already ${row.status} and cannot be cancelled`,
    });
    return;
  }

  const result = await requestJobCancellation(id);
  // The row could have changed status between the read above and the
  // conditional UPDATE inside requestJobCancellation (e.g. a worker just
  // claimed a pending job, or a running job just finished). Surface that
  // race the same way we would if the caller had observed the new state
  // directly.
  if (!result.cancelRequested) {
    res.status(409).json({
      error: "Job is no longer cancellable (already completed)",
    });
    return;
  }

  req.log.info(
    {
      jobId: id,
      kind: row.kind,
      previousStatus: row.status,
      cancelledImmediately: result.cancelledImmediately,
    },
    "Job cancellation requested",
  );

  res.status(202).json({
    jobId: id,
    status: result.cancelledImmediately ? "cancelled" : "running",
    cancelRequested: true,
    cancelledImmediately: result.cancelledImmediately,
  });
});

export default router;
