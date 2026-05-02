/**
 * Public surface for the intelligence foundation.
 *
 * Imports stay namespaced (`@workspace/intelligence/bq`,
 * `/gcs`, `/entities`, `/tier`, `/contracts`) so callers can see at the
 * import site which subsystem they're touching, while a small set of
 * common types are re-exported here for convenience.
 */

export * from "./contracts/index.js";
export {
  resolveIntelligenceConfig,
  isIntelligenceEnabled,
  type IntelligenceConfig,
} from "./config.js";
export {
  ensureWarehouseSchema,
  mergeMarketSignals,
  recordCollectorRun,
  getCollectorCostsFromBq,
  getCollectorCostsFromBilling,
  getCollectorCostsFromInformationSchema,
  __setRecordCollectorRunOverrideForTests,
  __clearCollectorCostCacheForTests,
  type BqMarketSignalRow,
  type CollectorRunRecord,
  type CollectorCostRow,
} from "./bq/index.js";
export {
  landRawPayload,
  listRawPayloads,
  readRawPayload,
  rawPayloadPath,
  rawPayloadPointer,
  __setLandRawPayloadOverrideForTests,
  type LandPayloadArgs,
  type LandPayloadResult,
} from "./gcs/index.js";
export {
  resolveEntity,
  buildCacheKey,
  normaliseName,
  deterministicUidFromIdentifier,
  type ResolveEntityArgs,
  type ResolvedEntity,
  type MatchType,
  type IdentifierKind,
  type Identifiers,
} from "./entities/index.js";
export {
  renderInsight,
  type RenderedInsight,
  type Citation,
  type ProvenanceTrail,
} from "./tier/index.js";
export {
  computeStableSignalKey,
  type StableSignalKeyParts,
} from "./signalKey/index.js";
export {
  RISK_DIMENSIONS,
  scoreDimension,
  scoreAllDimensions,
  scoreBand,
  type RiskDimension,
  type ScoringSignal,
  type ScoringOptions,
  type ScoreContribution,
  type ScoreResult,
} from "./scoring/composite.js";
export {
  createAlert,
  transitionAlert,
  appendAlertEvent,
  evaluateRulesForSignal,
  wakeExpiredSnoozes,
  severityAtLeast,
  isAlertSeverity,
  type CreateAlertInput,
  type CreateAlertResult,
  type TransitionAlertInput,
  type AlertCandidate,
  type RuleMatch,
} from "./alerts/index.js";
