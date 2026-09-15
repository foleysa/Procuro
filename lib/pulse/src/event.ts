import type { LeverId } from "@workspace/db/schema";
import {
  isPulseDecideAction,
  type PulseDecideAction,
} from "./decide";
import {
  isPulseEditionTag,
  type PulseEditionTag,
} from "./editions";
import {
  isPulseLearnOutcome,
  type PulseLearnOutcome,
} from "./learn";

/**
 * Layer C phases only. Observe is Layer A (`market_signals` /
 * `observe_payload`). Orient stays on the desk (`orient_payload`).
 */
export const pulseLayerCPhases = ["decide", "learn"] as const;
export type PulseLayerCPhase = (typeof pulseLayerCPhases)[number];

/**
 * Owner role — not a person. Do not store names, emails, or other PII
 * on Layer C events.
 */
export const pulseOwnerRoles = [
  "cpo",
  "proc_ops",
  "sc_lead",
  "category_owner",
  "finance",
  "other",
] as const;
export type PulseOwnerRole = (typeof pulseOwnerRoles)[number];

const PHASE_SET = new Set<string>(pulseLayerCPhases);
const ROLE_SET = new Set<string>(pulseOwnerRoles);

export function isPulseLayerCPhase(value: string): value is PulseLayerCPhase {
  return PHASE_SET.has(value);
}

export function isPulseOwnerRole(value: string): value is PulseOwnerRole {
  return ROLE_SET.has(value);
}

export const PULSE_LAYER_C_SCHEMA_VERSION = 1 as const;

/**
 * Minimal labeled Decide / Learn event. One spine, vertical tags — not
 * eight databases. Does not persist itself; desk writers can attach
 * this shape later without a cycle rewrite.
 */
export interface PulseLayerCEvent {
  schemaVersion: typeof PULSE_LAYER_C_SCHEMA_VERSION;
  phase: PulseLayerCPhase;
  verticalTags: PulseEditionTag[];
  leverId: LeverId | null;
  decideAction: PulseDecideAction | null;
  learnOutcome: PulseLearnOutcome | null;
  ownerRole: PulseOwnerRole | null;
  /** ISO-8601 timestamp. */
  occurredAt: string;
  /** `analysis_cycles.id` when the event came from a desk cycle. */
  cycleId: string | null;
  opportunityId: string | null;
  marketSignalId: string | null;
  /**
   * Tenant-local $ at stake. Never a published Pulse metric, ARR,
   * savings %, or peer percentile.
   */
  tenantLocalStakeUsd: number | null;
}

export function isIsoTimestamp(value: string): boolean {
  if (value.length < 10) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms);
}

export function parsePulseLayerCEvent(
  input: unknown,
): PulseLayerCEvent | null {
  if (input == null || typeof input !== "object") return null;
  const row = input as Record<string, unknown>;
  if (row.schemaVersion !== PULSE_LAYER_C_SCHEMA_VERSION) return null;
  if (typeof row.phase !== "string" || !isPulseLayerCPhase(row.phase)) {
    return null;
  }
  if (!Array.isArray(row.verticalTags) || row.verticalTags.length === 0) {
    return null;
  }
  if (!row.verticalTags.every((t) => typeof t === "string" && isPulseEditionTag(t))) {
    return null;
  }
  if (typeof row.occurredAt !== "string" || !isIsoTimestamp(row.occurredAt)) {
    return null;
  }
  if (row.decideAction != null) {
    if (typeof row.decideAction !== "string" || !isPulseDecideAction(row.decideAction)) {
      return null;
    }
  }
  if (row.learnOutcome != null) {
    if (typeof row.learnOutcome !== "string" || !isPulseLearnOutcome(row.learnOutcome)) {
      return null;
    }
  }
  if (row.ownerRole != null) {
    if (typeof row.ownerRole !== "string" || !isPulseOwnerRole(row.ownerRole)) {
      return null;
    }
  }
  if (row.phase === "decide" && row.decideAction == null) return null;
  if (row.phase === "learn" && row.learnOutcome == null) return null;
  if (
    row.tenantLocalStakeUsd != null &&
    (typeof row.tenantLocalStakeUsd !== "number" ||
      !Number.isFinite(row.tenantLocalStakeUsd))
  ) {
    return null;
  }
  const asNullableString = (value: unknown): string | null => {
    if (value == null) return null;
    return typeof value === "string" ? value : null;
  };
  if (row.leverId != null && typeof row.leverId !== "string") return null;
  if (row.cycleId != null && typeof row.cycleId !== "string") return null;
  if (row.opportunityId != null && typeof row.opportunityId !== "string") {
    return null;
  }
  if (row.marketSignalId != null && typeof row.marketSignalId !== "string") {
    return null;
  }

  return {
    schemaVersion: PULSE_LAYER_C_SCHEMA_VERSION,
    phase: row.phase,
    verticalTags: row.verticalTags as PulseEditionTag[],
    leverId: asNullableString(row.leverId) as LeverId | null,
    decideAction: (row.decideAction as PulseDecideAction | null) ?? null,
    learnOutcome: (row.learnOutcome as PulseLearnOutcome | null) ?? null,
    ownerRole: (row.ownerRole as PulseOwnerRole | null) ?? null,
    occurredAt: row.occurredAt,
    cycleId: asNullableString(row.cycleId),
    opportunityId: asNullableString(row.opportunityId),
    marketSignalId: asNullableString(row.marketSignalId),
    tenantLocalStakeUsd:
      typeof row.tenantLocalStakeUsd === "number"
        ? row.tenantLocalStakeUsd
        : null,
  };
}
