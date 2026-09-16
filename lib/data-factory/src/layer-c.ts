/**
 * Layer C taxonomy stub — Decide → Learn labels the desk can attach
 * to PUBLIC Layer A signals.
 *
 * Enum strings are identical to `@workspace/pulse` on
 * `grace/pulse-layer-c-taxonomy` (PR #30). Do not fork them. When that
 * package lands on main, re-export from there.
 *
 * Day 0 difference vs PR #30: labels attach to `publicSignalId`
 * (Layer A). `tenantLocalStakeUsd`, opportunity ids, defense-pack
 * outcomes, and FSA engagement ids are out of scope — John has no
 * client/tenant data.
 */

export const DATA_FACTORY_LAYER_C_SCHEMA_VERSION = 1 as const;

/** Same closed set as `pulseDecideActions` (PR #30). */
export const dataFactoryDecideActions = [
  "renegotiate",
  "dual_source",
  "switch_lane",
  "hold",
  "kill",
] as const;
export type DataFactoryDecideAction =
  (typeof dataFactoryDecideActions)[number];

/** Same closed set as `pulseLearnOutcomes` (PR #30). `unknown` is first-class. */
export const dataFactoryLearnOutcomes = [
  "saved",
  "missed",
  "unknown",
  "reversed",
] as const;
export type DataFactoryLearnOutcome =
  (typeof dataFactoryLearnOutcomes)[number];

export const dataFactoryLayerCPhases = ["decide", "learn"] as const;
export type DataFactoryLayerCPhase =
  (typeof dataFactoryLayerCPhases)[number];

/** Role only — no names, emails, or FSA engagement identifiers. */
export const dataFactoryOwnerRoles = [
  "cpo",
  "proc_ops",
  "sc_lead",
  "category_owner",
  "finance",
  "other",
] as const;
export type DataFactoryOwnerRole = (typeof dataFactoryOwnerRoles)[number];

/**
 * Observe kinds from PR #30 `pulseObserveKinds`. Layer A groups, not
 * Layer C — listed here so the desk can suggest Decide actions against
 * a public signal family.
 */
export const dataFactoryObserveKinds = [
  "price_index",
  "disruption_policy",
  "supplier_public",
  "logistics_lane",
] as const;
export type DataFactoryObserveKind =
  (typeof dataFactoryObserveKinds)[number];

const DECIDE_SET = new Set<string>(dataFactoryDecideActions);
const LEARN_SET = new Set<string>(dataFactoryLearnOutcomes);
const PHASE_SET = new Set<string>(dataFactoryLayerCPhases);
const ROLE_SET = new Set<string>(dataFactoryOwnerRoles);
const OBSERVE_SET = new Set<string>(dataFactoryObserveKinds);

export function isDataFactoryDecideAction(
  value: string,
): value is DataFactoryDecideAction {
  return DECIDE_SET.has(value);
}

export function isDataFactoryLearnOutcome(
  value: string,
): value is DataFactoryLearnOutcome {
  return LEARN_SET.has(value);
}

export function isDataFactoryLayerCPhase(
  value: string,
): value is DataFactoryLayerCPhase {
  return PHASE_SET.has(value);
}

export function isDataFactoryOwnerRole(
  value: string,
): value is DataFactoryOwnerRole {
  return ROLE_SET.has(value);
}

export function isDataFactoryObserveKind(
  value: string,
): value is DataFactoryObserveKind {
  return OBSERVE_SET.has(value);
}

/**
 * Eligible Decide actions for a public Observe kind. Suggestions only —
 * never auto-applied, never a published Pulse metric.
 */
export const suggestedDecideForObserveKind: Record<
  DataFactoryObserveKind,
  readonly DataFactoryDecideAction[]
> = {
  price_index: ["renegotiate", "hold"],
  logistics_lane: ["switch_lane", "dual_source", "hold"],
  disruption_policy: ["hold", "dual_source", "kill"],
  supplier_public: ["renegotiate", "dual_source", "hold", "kill"],
};

export interface DataFactoryLayerCLabel {
  schemaVersion: typeof DATA_FACTORY_LAYER_C_SCHEMA_VERSION;
  phase: DataFactoryLayerCPhase;
  publicSignalId: string;
  packageId: string | null;
  decideAction: DataFactoryDecideAction | null;
  learnOutcome: DataFactoryLearnOutcome | null;
  ownerRole: DataFactoryOwnerRole | null;
  /** ISO-8601 timestamp. */
  occurredAt: string;
}

function isIsoTimestamp(value: string): boolean {
  if (value.length < 10) return false;
  return Number.isFinite(Date.parse(value));
}

/**
 * Stub validator. Rejects tenant-stake fields if a caller tries to
 * smuggle them in — Day 0 labels public signals only.
 */
export function parseDataFactoryLayerCLabel(
  input: unknown,
): DataFactoryLayerCLabel | null {
  if (input == null || typeof input !== "object") return null;
  const row = input as Record<string, unknown>;
  if (row.schemaVersion !== DATA_FACTORY_LAYER_C_SCHEMA_VERSION) return null;
  if (typeof row.phase !== "string" || !isDataFactoryLayerCPhase(row.phase)) {
    return null;
  }
  if (typeof row.publicSignalId !== "string" || row.publicSignalId.length === 0) {
    return null;
  }
  if (typeof row.occurredAt !== "string" || !isIsoTimestamp(row.occurredAt)) {
    return null;
  }
  if (
    "tenantLocalStakeUsd" in row &&
    row.tenantLocalStakeUsd != null
  ) {
    // John has no tenant data. Do not accept a stake field on Day 0.
    return null;
  }
  if (row.decideAction != null) {
    if (
      typeof row.decideAction !== "string" ||
      !isDataFactoryDecideAction(row.decideAction)
    ) {
      return null;
    }
  }
  if (row.learnOutcome != null) {
    if (
      typeof row.learnOutcome !== "string" ||
      !isDataFactoryLearnOutcome(row.learnOutcome)
    ) {
      return null;
    }
  }
  if (row.ownerRole != null) {
    if (
      typeof row.ownerRole !== "string" ||
      !isDataFactoryOwnerRole(row.ownerRole)
    ) {
      return null;
    }
  }
  if (row.phase === "decide" && row.decideAction == null) return null;
  if (row.phase === "learn" && row.learnOutcome == null) return null;
  if (row.packageId != null && typeof row.packageId !== "string") return null;

  return {
    schemaVersion: DATA_FACTORY_LAYER_C_SCHEMA_VERSION,
    phase: row.phase,
    publicSignalId: row.publicSignalId,
    packageId: typeof row.packageId === "string" ? row.packageId : null,
    decideAction: (row.decideAction as DataFactoryDecideAction | null) ?? null,
    learnOutcome: (row.learnOutcome as DataFactoryLearnOutcome | null) ?? null,
    ownerRole: (row.ownerRole as DataFactoryOwnerRole | null) ?? null,
    occurredAt: row.occurredAt,
  };
}

export function layerCTaxonomyPayload() {
  return {
    schemaVersion: DATA_FACTORY_LAYER_C_SCHEMA_VERSION,
    alignsWith: "PR #30 Pulse Layer C taxonomy (Decide/Learn + owner roles)",
    pulsePackage: "@workspace/pulse",
    attachTo: "public Layer A signals only",
    phases: dataFactoryLayerCPhases,
    decideActions: dataFactoryDecideActions.map((id) => ({
      id,
      meaning: decideMeaning(id),
    })),
    learnOutcomes: dataFactoryLearnOutcomes.map((id) => ({
      id,
      meaning: learnMeaning(id),
    })),
    ownerRoles: dataFactoryOwnerRoles,
    observeKinds: dataFactoryObserveKinds,
    suggestedDecideForObserveKind,
    fences: [
      "unknown Learn is first-class; reject/expire do not imply missed",
      "no tenantLocalStakeUsd on Day 0 labels",
      "no FSA engagement identifiers",
      "do not publish these labels as Pulse ROI or peer percentiles",
    ],
  };
}

function decideMeaning(action: DataFactoryDecideAction): string {
  switch (action) {
    case "renegotiate":
      return "Reopen price / terms";
    case "dual_source":
      return "Add or split source";
    case "switch_lane":
      return "Change lane / mode";
    case "hold":
      return "Wait";
    case "kill":
      return "Do not pursue";
  }
}

function learnMeaning(outcome: DataFactoryLearnOutcome): string {
  switch (outcome) {
    case "saved":
      return "Outcome beat the baseline (tenant-local; not a published Pulse metric)";
    case "missed":
      return "Outcome missed the baseline (tenant-local; not a published Pulse metric)";
    case "unknown":
      return "Not yet known — first-class, do not guess";
    case "reversed":
      return "A prior Learn was undone";
  }
}
