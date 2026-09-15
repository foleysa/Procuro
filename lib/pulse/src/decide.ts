import {
  decisionEventTypes,
  type DecisionEventType,
  type LeverId,
  type SourcingStrategy,
} from "@workspace/db/schema";

/**
 * Layer C Decide — what the operator chose to do.
 *
 * This is judgment, not the desk lifecycle in `decisions.event_type`
 * (`approve` / `reject` / `execute` / `realize` / `snooze` / `unsnooze`).
 * Those lifecycle events can *hint* at a Decide action; they do not
 * replace it.
 */
export const pulseDecideActions = [
  "renegotiate",
  "dual_source",
  "switch_lane",
  "hold",
  "kill",
] as const;
export type PulseDecideAction = (typeof pulseDecideActions)[number];

const DECIDE_SET = new Set<string>(pulseDecideActions);

export function isPulseDecideAction(
  value: string,
): value is PulseDecideAction {
  return DECIDE_SET.has(value);
}

/**
 * Conservative map from desk lifecycle → Decide.
 * Only events that *are* a judgment get a value. Approve / execute /
 * realize / unsnooze stay unlabeled until an operator (or lever /
 * sourcing-strategy hint) names the action.
 */
export function decideActionFromDeskEvent(
  eventType: DecisionEventType,
): PulseDecideAction | null {
  switch (eventType) {
    case "snooze":
      return "hold";
    case "reject":
      return "kill";
    case "approve":
    case "execute":
    case "realize":
    case "unsnooze":
      return null;
    default: {
      const _exhaustive: never = eventType;
      return _exhaustive;
    }
  }
}

/**
 * Narrow lever → Decide hints. Most levers stay unlabeled so we do not
 * invent an action the operator never chose.
 */
export function decideActionFromLeverId(
  leverId: LeverId,
): PulseDecideAction | null {
  switch (leverId) {
    case "contract_renegotiation_trigger":
      return "renegotiate";
    case "dual_sourcing":
      return "dual_source";
    case "freight_mode_optimization":
    case "lane_consolidation":
      return "switch_lane";
    default:
      return null;
  }
}

export function decideActionFromSourcingStrategy(
  strategy: SourcingStrategy,
): PulseDecideAction | null {
  switch (strategy) {
    case "Negotiated Renewal":
    case "Should-Cost Challenge":
      return "renegotiate";
    case "Single-to-Dual Source":
      return "dual_source";
    default:
      return null;
  }
}

/** Desk lifecycle enum this taxonomy aligns to — drift check for tests. */
export const alignedDeskDecisionEventTypes = decisionEventTypes;
