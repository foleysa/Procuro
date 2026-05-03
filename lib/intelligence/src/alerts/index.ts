/**
 * Alerts ingestion + lifecycle module.
 *
 * Public surface:
 *   - `createAlert(input)`  — primary write path. All callers go through
 *     this so dedupe/occurrence-bumping and rule evaluation happen in one
 *     place. Direct INSERTs into `alertsTable` are forbidden by
 *     convention (and by code review).
 *   - `transitionAlert({alertId, action, actor, ...})` — ack / snooze /
 *     resolve / reopen / assign / comment. Always appends an
 *     `alert_events` row.
 *   - `evaluateRulesForSignal(orgId, candidate)` — pure function that
 *     decides whether a candidate alert matches any of the tenant's
 *     enabled rules. Used by collector fan-out before persisting.
 *
 * Note on de-duplication: when a producer supplies a `dedupeKey`,
 * `createAlert` UPSERTs against `(org_id, dedupe_key)`. If a row
 * already exists we bump `occurrences`/`lastSeenAt` (and append an
 * `occurrence` event) instead of inserting a new alert.
 *
 * `payload.sources` is conventionally an `InsightSource[]` so the
 * Command Center can re-use its existing `insight-citations`
 * component to render provenance.
 */

import {
  db,
  alertsTable,
  alertEventsTable,
  alertRulesTable,
  watchlistMembersTable,
  watchlistsTable,
  alertSeverityValues,
  type AlertRow,
  type AlertSeverity,
  type AlertSource,
  type AlertEventType,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

const SEVERITY_RANK: Record<AlertSeverity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export function severityAtLeast(
  actual: AlertSeverity,
  threshold: AlertSeverity,
): boolean {
  return SEVERITY_RANK[actual] >= SEVERITY_RANK[threshold];
}

export function isAlertSeverity(v: unknown): v is AlertSeverity {
  return (
    typeof v === "string" &&
    (alertSeverityValues as readonly string[]).includes(v)
  );
}

export interface CreateAlertInput {
  orgId: string;
  severity: AlertSeverity;
  source: AlertSource;
  /** Producer-defined sub-kind (e.g. "ofac_sdn_match"). */
  kind: string;
  title: string;
  summary?: string;
  /**
   * Stable de-dup key. Identical `(orgId, dedupeKey)` UPSERTs into the
   * existing row instead of inserting a new alert. Producers without a
   * sensible key may omit this — every call then creates a fresh row.
   */
  dedupeKey?: string;
  /** Free-form payload; conventionally carries `sources: InsightSource[]`. */
  payload?: Record<string, unknown>;
  entityUid?: string | null;
  supplierId?: string | null;
  contractId?: string | null;
  opportunityId?: string | null;
  /** Optional: actor on the audit trail's `created` event. */
  actor?: string;
}

export interface CreateAlertResult {
  alert: AlertRow;
  /**
   * `created` when a brand-new alert row was inserted; `bumped` when an
   * existing dedupe-keyed row had its `occurrences` incremented.
   */
  outcome: "created" | "bumped";
}

/**
 * Single write path for new alerts. Handles dedupe, occurrence-bumping,
 * and the `created` / `occurrence` audit event. Caller is responsible
 * for severity adjustment (e.g. via `evaluateRulesForSignal`); this
 * function just persists what it's told.
 */
export async function createAlert(
  input: CreateAlertInput,
): Promise<CreateAlertResult> {
  const id = newId("alert");
  const now = new Date();

  // Fast path: no dedupe key, always insert.
  if (!input.dedupeKey) {
    const [row] = await db
      .insert(alertsTable)
      .values({
        id,
        orgId: input.orgId,
        severity: input.severity,
        source: input.source,
        kind: input.kind,
        title: input.title,
        summary: input.summary ?? "",
        dedupeKey: null,
        payload: input.payload ?? {},
        entityUid: input.entityUid ?? null,
        supplierId: input.supplierId ?? null,
        contractId: input.contractId ?? null,
        opportunityId: input.opportunityId ?? null,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .returning();
    if (!row) throw new Error("createAlert: insert returned no row");
    await appendAlertEvent({
      alertId: row.id,
      eventType: "created",
      actor: input.actor ?? null,
      note: null,
      metadata: { source: input.source, severity: input.severity },
    });
    return { alert: row, outcome: "created" };
  }

  // Dedupe path: UPSERT on (org_id, dedupe_key).
  const inserted = await db
    .insert(alertsTable)
    .values({
      id,
      orgId: input.orgId,
      severity: input.severity,
      source: input.source,
      kind: input.kind,
      title: input.title,
      summary: input.summary ?? "",
      dedupeKey: input.dedupeKey,
      payload: input.payload ?? {},
      entityUid: input.entityUid ?? null,
      supplierId: input.supplierId ?? null,
      contractId: input.contractId ?? null,
      opportunityId: input.opportunityId ?? null,
      firstSeenAt: now,
      lastSeenAt: now,
    })
    .onConflictDoNothing({
      target: [alertsTable.orgId, alertsTable.dedupeKey],
    })
    .returning();

  if (inserted.length > 0) {
    const row = inserted[0]!;
    await appendAlertEvent({
      alertId: row.id,
      eventType: "created",
      actor: input.actor ?? null,
      note: null,
      metadata: { source: input.source, severity: input.severity },
    });
    return { alert: row, outcome: "created" };
  }

  // Existing row: bump occurrences + lastSeenAt.
  const [existing] = await db
    .select()
    .from(alertsTable)
    .where(
      and(
        eq(alertsTable.orgId, input.orgId),
        eq(alertsTable.dedupeKey, input.dedupeKey),
      ),
    )
    .limit(1);
  if (!existing) {
    throw new Error(
      `createAlert: dedupe row vanished after onConflict (orgId=${input.orgId}, dedupeKey=${input.dedupeKey})`,
    );
  }
  const [bumped] = await db
    .update(alertsTable)
    .set({
      occurrences: existing.occurrences + 1,
      lastSeenAt: now,
      // Bump severity if the new occurrence is more severe — never lower.
      severity:
        SEVERITY_RANK[input.severity] > SEVERITY_RANK[existing.severity]
          ? input.severity
          : existing.severity,
      // Reopen if previously resolved — re-occurrence of a resolved
      // alert is itself news.
      state: existing.state === "resolved" ? "open" : existing.state,
    })
    .where(eq(alertsTable.id, existing.id))
    .returning();
  await appendAlertEvent({
    alertId: existing.id,
    eventType: "occurrence",
    actor: input.actor ?? null,
    note: null,
    metadata: { occurrences: (bumped ?? existing).occurrences },
  });
  return { alert: bumped ?? existing, outcome: "bumped" };
}

export interface TransitionAlertInput {
  alertId: string;
  action: "ack" | "snooze" | "resolve" | "reopen" | "assign" | "comment";
  actor: string;
  note?: string;
  /** snooze: ISO-8601 wake-up time. */
  snoozedUntil?: Date;
  /** assign: user id of the new assignee (null to unassign). */
  assignedToUserId?: string | null;
}

export async function transitionAlert(
  input: TransitionAlertInput,
): Promise<AlertRow> {
  const [current] = await db
    .select()
    .from(alertsTable)
    .where(eq(alertsTable.id, input.alertId))
    .limit(1);
  if (!current) {
    throw new Error(`transitionAlert: alert ${input.alertId} not found`);
  }

  const now = new Date();
  let nextState = current.state;
  let eventType: AlertEventType;
  const updates: Partial<typeof alertsTable.$inferInsert> = {};

  switch (input.action) {
    case "ack":
      if (current.state === "resolved") {
        throw new Error("Cannot acknowledge a resolved alert; reopen first");
      }
      nextState = "acknowledged";
      updates.state = nextState;
      updates.acknowledgedAt = now;
      updates.acknowledgedBy = input.actor;
      eventType = "acknowledged";
      break;
    case "snooze":
      if (!input.snoozedUntil) {
        throw new Error("transitionAlert(snooze) requires snoozedUntil");
      }
      nextState = "snoozed";
      updates.state = nextState;
      updates.snoozedUntil = input.snoozedUntil;
      eventType = "snoozed";
      break;
    case "resolve":
      nextState = "resolved";
      updates.state = nextState;
      updates.resolvedAt = now;
      updates.resolvedBy = input.actor;
      eventType = "resolved";
      break;
    case "reopen":
      nextState = "open";
      updates.state = nextState;
      updates.acknowledgedAt = null;
      updates.acknowledgedBy = null;
      updates.resolvedAt = null;
      updates.resolvedBy = null;
      updates.snoozedUntil = null;
      eventType = "reopened";
      break;
    case "assign":
      updates.assignedToUserId = input.assignedToUserId ?? null;
      eventType = "assigned";
      break;
    case "comment":
      eventType = "comment";
      break;
  }

  let updated: AlertRow = current;
  if (Object.keys(updates).length > 0) {
    const [row] = await db
      .update(alertsTable)
      .set(updates)
      .where(eq(alertsTable.id, input.alertId))
      .returning();
    if (row) updated = row;
  }

  await appendAlertEvent({
    alertId: input.alertId,
    eventType,
    actor: input.actor,
    note: input.note ?? null,
    metadata:
      input.action === "snooze" && input.snoozedUntil
        ? { snoozedUntil: input.snoozedUntil.toISOString() }
        : input.action === "assign"
          ? { assignedToUserId: input.assignedToUserId ?? null }
          : {},
  });

  return updated;
}

interface AppendAlertEventArgs {
  alertId: string;
  eventType: AlertEventType;
  actor: string | null;
  note: string | null;
  metadata: Record<string, unknown>;
}

export async function appendAlertEvent(
  args: AppendAlertEventArgs,
): Promise<void> {
  await db.insert(alertEventsTable).values({
    id: newId("ae"),
    alertId: args.alertId,
    eventType: args.eventType,
    actor: args.actor,
    note: args.note,
    metadata: args.metadata,
  });
}

/**
 * Wake snoozed alerts whose `snoozedUntil` has passed back to `open`.
 * Called from the escalation worker so the inbox doesn't show
 * permanent "snoozed" rows long after their snooze expired.
 */
export async function wakeExpiredSnoozes(): Promise<number> {
  const r = await db.execute<{ id: string }>(sql`
    UPDATE alerts
    SET state = 'open', snoozed_until = NULL, updated_at = now()
    WHERE state = 'snoozed' AND snoozed_until IS NOT NULL AND snoozed_until <= now()
    RETURNING id
  `);
  return r.rows.length;
}

/**
 * Candidate alert evaluated against tenant rules. The candidate carries
 * the producer's intended severity; rule evaluation may *raise* it but
 * never lower (a rule signalling lower severity than the producer's
 * default is treated as "match, keep producer severity").
 */
export interface AlertCandidate {
  source: AlertSource;
  severity: AlertSeverity;
  supplierId: string | null;
  entityUid: string | null;
}

export interface RuleMatch {
  ruleId: string;
  effectiveSeverity: AlertSeverity;
}

/**
 * Evaluate `candidate` against every enabled rule for `orgId`. Returns
 * the matching rules (possibly empty). The producer is expected to use
 * the highest-severity match's `effectiveSeverity` and tag the alert
 * with `source = rule_match` if at least one rule matched.
 *
 * Condition DSL (recognised top-level keys):
 *   - `anyOfSources`: string[]   — match if `candidate.source` is in the list
 *   - `minSeverity`: AlertSeverity — match only if candidate ≥ this
 *   - `supplierIds`: string[]    — match if candidate.supplierId is in list
 *   - (rule.watchlistId)         — match only if candidate hits a member
 */
export async function evaluateRulesForSignal(
  orgId: string,
  candidate: AlertCandidate,
): Promise<RuleMatch[]> {
  const rules = await db
    .select()
    .from(alertRulesTable)
    .where(
      and(eq(alertRulesTable.orgId, orgId), eq(alertRulesTable.enabled, true)),
    );
  if (rules.length === 0) return [];

  const matches: RuleMatch[] = [];
  for (const rule of rules) {
    const cond = (rule.condition ?? {}) as Record<string, unknown>;
    const anyOfSources = cond["anyOfSources"];
    if (
      Array.isArray(anyOfSources) &&
      anyOfSources.length > 0 &&
      !anyOfSources.includes(candidate.source)
    ) {
      continue;
    }
    const minSeverity = cond["minSeverity"];
    if (
      typeof minSeverity === "string" &&
      isAlertSeverity(minSeverity) &&
      !severityAtLeast(candidate.severity, minSeverity)
    ) {
      continue;
    }
    const supplierIds = cond["supplierIds"];
    if (
      Array.isArray(supplierIds) &&
      supplierIds.length > 0 &&
      (!candidate.supplierId || !supplierIds.includes(candidate.supplierId))
    ) {
      continue;
    }
    if (rule.watchlistId) {
      const members = await db
        .select({
          supplierId: watchlistMembersTable.supplierId,
          entityUid: watchlistMembersTable.entityUid,
        })
        .from(watchlistMembersTable)
        .innerJoin(
          watchlistsTable,
          eq(watchlistMembersTable.watchlistId, watchlistsTable.id),
        )
        .where(
          and(
            eq(watchlistMembersTable.watchlistId, rule.watchlistId),
            eq(watchlistsTable.orgId, orgId),
          ),
        );
      const supplierMatch =
        !!candidate.supplierId &&
        members.some((m) => m.supplierId === candidate.supplierId);
      const entityMatch =
        !!candidate.entityUid &&
        members.some((m) => m.entityUid === candidate.entityUid);
      if (!supplierMatch && !entityMatch) continue;
    }

    const effective: AlertSeverity =
      SEVERITY_RANK[rule.severity] > SEVERITY_RANK[candidate.severity]
        ? rule.severity
        : candidate.severity;
    matches.push({ ruleId: rule.id, effectiveSeverity: effective });
  }
  return matches;
}
