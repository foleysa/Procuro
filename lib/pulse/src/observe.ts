import {
  marketSignalTypes,
  type MarketSignalType,
} from "@workspace/db/schema";

/**
 * Pulse Observe kinds — Layer A public / licensed signal, grouped for
 * the brief. Maps 1:1 onto existing `market_signals.signal_type`.
 * This is not Layer C (Decide/Learn).
 */
export const pulseObserveKinds = [
  "price_index",
  "disruption_policy",
  "supplier_public",
  "logistics_lane",
] as const;
export type PulseObserveKind = (typeof pulseObserveKinds)[number];

const OBSERVE_KIND_SET = new Set<string>(pulseObserveKinds);

export function isPulseObserveKind(value: string): value is PulseObserveKind {
  return OBSERVE_KIND_SET.has(value);
}

const MARKET_SIGNAL_TO_OBSERVE: Record<MarketSignalType, PulseObserveKind> = {
  commodity_index: "price_index",
  freight_rate: "logistics_lane",
  supplier_price_list: "price_index",
  marketplace_price: "price_index",
  public_bid_award: "disruption_policy",
  customs_trade: "disruption_policy",
  supplier_financial: "supplier_public",
  supplier_risk_news: "supplier_public",
  services_rate_card: "price_index",
  economic_index: "price_index",
  fx_rate: "price_index",
  corporate_filing: "supplier_public",
  event_geocoded: "disruption_policy",
  entity_news_event: "disruption_policy",
  sanctions_match: "disruption_policy",
  risk_screening_match: "disruption_policy",
  entity_registry: "supplier_public",
  facility_emissions: "supplier_public",
  natural_hazard: "disruption_policy",
  environmental_violation: "disruption_policy",
  workplace_safety_incident: "disruption_policy",
  wage_benchmark: "price_index",
};

export function observeKindFromMarketSignalType(
  signalType: MarketSignalType,
): PulseObserveKind {
  return MARKET_SIGNAL_TO_OBSERVE[signalType];
}

/** Desk signal-type enum this Observe map must stay complete against. */
export const alignedMarketSignalTypes = marketSignalTypes;
