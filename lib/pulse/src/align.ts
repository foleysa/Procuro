import type { LeverId, MarketSignalType } from "@workspace/db/schema";
import type { PulseDecideAction } from "./decide";
import type { PulseDay030EditionTag, PulseEditionTag } from "./editions";
import type { PulseObserveKind } from "./observe";

/**
 * Pulse Observe → Decide → Learn mapped onto existing OODA cycle
 * columns. Desk runtime is unchanged. Pulse does not rewrite
 * `runAnalysisCycle`.
 *
 * Desk order today (`artifacts/api-server/src/lib/ooda/cycle.ts`):
 *   Observe → Learn(previous) → Orient → Decide → Act
 * Pulse product loop (brief):
 *   Observe → (Orient questions in prose) → Decide → Learn
 */

export const pulseToCycleField = {
  observe: "observe_payload",
  orient: "orient_payload",
  decide: "decide_payload",
  act: "act_payload",
  learn: "learn_payload",
} as const;

export type PulseCyclePhase = keyof typeof pulseToCycleField;
export type AnalysisCyclePayloadField =
  (typeof pulseToCycleField)[PulseCyclePhase];

export const pulsePhaseNotes: Record<PulseCyclePhase, string> = {
  observe:
    "Layer A. Pulse Observe items cite public/licensed `market_signals` and the cycle `observe_payload` snapshot. Not Layer C.",
  orient:
    "Desk-only priors + exclusions in `orient_payload`. Pulse may pose Orient questions in an issue; it does not persist Orient.",
  decide:
    "Cycle `decide_payload` is ranked drafts. Layer C Decide is the operator action enum on an opportunity, tagged by vertical + lever.",
  act: "Light close-the-loop only (`act_payload`, `decisions.event_type=execute`). Pulse does not own POs or become a suite.",
  learn:
    "Cycle `learn_payload` updates priors from previous outcomes. Layer C Learn is saved/missed/unknown/reversed. Unknown is first-class. Desk Learn never auto-publishes to Pulse.",
};

export interface PulseCoreObserveItem {
  kind: PulseObserveKind;
  verticalTags: PulseEditionTag[];
  marketSignalType?: MarketSignalType;
  marketSignalId?: string;
  /** Public citation or licensed series name — not a metric claim. */
  sourceLabel: string;
  summary: string;
}

export interface PulseSuggestedDecide {
  decideAction: PulseDecideAction;
  verticalTags: PulseEditionTag[];
  leverId?: LeverId;
  /** Suggested question / action in operator language. Not a savings claim. */
  prompt: string;
}

export const pulseCoreCadences = ["weekly", "twice_monthly"] as const;
export type PulseCoreCadence = (typeof pulseCoreCadences)[number];

/**
 * Pulse Core issue stub. Horizontal SC / procurement / logistics brief
 * with optional edition chapters. Learn outcomes from the desk are
 * excluded until aggregation rules exist.
 */
export interface PulseCoreIssue {
  schemaVersion: 1;
  cadence: PulseCoreCadence;
  /** Edition skins in this issue (`mro`, `food`, …). Logistics is Core. */
  editionTags: PulseDay030EditionTag[];
  observe: PulseCoreObserveItem[];
  orientQuestions: string[];
  suggestedDecides: PulseSuggestedDecide[];
}

export function cycleFieldForPulsePhase(
  phase: PulseCyclePhase,
): AnalysisCyclePayloadField {
  return pulseToCycleField[phase];
}
