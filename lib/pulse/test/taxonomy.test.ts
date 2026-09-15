import { describe, expect, it } from "vitest";
import {
  decisionEventTypes,
  leverIds,
  marketSignalTypes,
  opportunityStatusValues,
} from "@workspace/db/schema";
import {
  alignedDeskDecisionEventTypes,
  alignedMarketSignalTypes,
  cycleFieldForPulsePhase,
  decideActionFromDeskEvent,
  decideActionFromLeverId,
  decideActionFromSourcingStrategy,
  deskCanEmitReversed,
  diligenceHorizontalSectionIds,
  diligenceSectionIds,
  isDiligenceSectionId,
  isPulseDecideAction,
  isPulseEditionTag,
  isPulseLearnOutcome,
  learnOutcomeFromDefensePack,
  learnOutcomeFromOpportunity,
  observeKindFromMarketSignalType,
  parsePulseLayerCEvent,
  pulseCoreLensTags,
  pulseDay030EditionTags,
  pulseDecideActions,
  pulseEditionTags,
  pulseEditionToTags,
  pulseLearnOutcomes,
  pulseToCycleField,
  tagsForPulseEdition,
} from "../src/index";

describe("Pulse edition tags", () => {
  it("Day 0–30 skins are mro and food only", () => {
    expect([...pulseDay030EditionTags]).toEqual(["mro", "food"]);
  });

  it("maps product editions to tags (Core = logistics lens, not a niche SKU)", () => {
    expect(tagsForPulseEdition("core")).toEqual(["logistics"]);
    expect(tagsForPulseEdition("mro")).toEqual(["mro"]);
    expect(tagsForPulseEdition("food")).toEqual(["food"]);
    expect(pulseEditionToTags.core).toEqual(pulseCoreLensTags);
  });

  it("accepts known tags and rejects niche / invented brands", () => {
    expect(isPulseEditionTag("mro")).toBe(true);
    expect(isPulseEditionTag("food")).toBe(true);
    expect(isPulseEditionTag("logistics")).toBe(true);
    expect(isPulseEditionTag("ocean-freight")).toBe(false);
    expect(isPulseEditionTag("fsa")).toBe(false);
  });

  it("does not treat reserved lenses as Day 0–30 skins", () => {
    expect(pulseEditionTags).toContain("healthcare");
    expect(pulseDay030EditionTags).not.toContain("healthcare");
  });
});

describe("Decide enums align with desk decisions — without replacing them", () => {
  it("keeps the brief action set", () => {
    expect([...pulseDecideActions]).toEqual([
      "renegotiate",
      "dual_source",
      "switch_lane",
      "hold",
      "kill",
    ]);
  });

  it("maps only judgment-shaped desk events", () => {
    expect(decideActionFromDeskEvent("snooze")).toBe("hold");
    expect(decideActionFromDeskEvent("reject")).toBe("kill");
    expect(decideActionFromDeskEvent("approve")).toBeNull();
    expect(decideActionFromDeskEvent("execute")).toBeNull();
    expect(decideActionFromDeskEvent("realize")).toBeNull();
    expect(decideActionFromDeskEvent("unsnooze")).toBeNull();
  });

  it("covers every current DecisionEventType", () => {
    expect(alignedDeskDecisionEventTypes).toEqual(decisionEventTypes);
    for (const eventType of decisionEventTypes) {
      expect(() => decideActionFromDeskEvent(eventType)).not.toThrow();
    }
  });

  it("hints from a few levers and sourcing strategies only", () => {
    expect(decideActionFromLeverId("dual_sourcing")).toBe("dual_source");
    expect(decideActionFromLeverId("lane_consolidation")).toBe("switch_lane");
    expect(decideActionFromLeverId("freight_mode_optimization")).toBe(
      "switch_lane",
    );
    expect(decideActionFromLeverId("contract_renegotiation_trigger")).toBe(
      "renegotiate",
    );
    expect(decideActionFromLeverId("maverick_spend")).toBeNull();
    expect(decideActionFromSourcingStrategy("Single-to-Dual Source")).toBe(
      "dual_source",
    );
    expect(decideActionFromSourcingStrategy("Negotiated Renewal")).toBe(
      "renegotiate",
    );
    expect(decideActionFromSourcingStrategy("Unclassified")).toBeNull();
  });

  it("does not invent a Decide for every lever", () => {
    const hinted = leverIds.filter(
      (id) => decideActionFromLeverId(id) !== null,
    );
    expect(hinted.length).toBeLessThan(leverIds.length);
    expect(hinted.length).toBe(4);
  });

  it("type-guards Decide actions", () => {
    expect(isPulseDecideAction("hold")).toBe(true);
    expect(isPulseDecideAction("approve")).toBe(false);
  });
});

describe("Learn enums — unknown is first-class; no fake wins", () => {
  it("uses saved / missed / unknown / reversed", () => {
    expect([...pulseLearnOutcomes]).toEqual([
      "saved",
      "missed",
      "unknown",
      "reversed",
    ]);
  });

  it("does not infer missed from reject or expire", () => {
    for (const status of opportunityStatusValues) {
      if (status === "realized") continue;
      expect(
        learnOutcomeFromOpportunity({ status, realizedSavingsUsd: 0 }),
      ).toBe("unknown");
    }
  });

  it("labels realized USD honestly", () => {
    expect(
      learnOutcomeFromOpportunity({
        status: "realized",
        realizedSavingsUsd: 1200,
      }),
    ).toBe("saved");
    expect(
      learnOutcomeFromOpportunity({
        status: "realized",
        realizedSavingsUsd: 0,
      }),
    ).toBe("missed");
    expect(
      learnOutcomeFromOpportunity({
        status: "realized",
        realizedSavingsUsd: null,
      }),
    ).toBe("unknown");
  });

  it("does not treat unused or unknown defense packs as missed", () => {
    expect(
      learnOutcomeFromDefensePack({ used: "unknown" }),
    ).toBe("unknown");
    expect(learnOutcomeFromDefensePack({ used: "no" })).toBe("unknown");
    expect(
      learnOutcomeFromDefensePack({
        used: "yes",
        outcomeCategory: "deal_lost",
      }),
    ).toBe("missed");
    expect(
      learnOutcomeFromDefensePack({
        used: "yes",
        outcomeCategory: "deferred",
      }),
    ).toBe("unknown");
  });

  it("does not auto-emit reversed from the desk", () => {
    expect(deskCanEmitReversed()).toBe(false);
  });

  it("type-guards Learn outcomes", () => {
    expect(isPulseLearnOutcome("unknown")).toBe(true);
    expect(isPulseLearnOutcome("roi_guaranteed")).toBe(false);
  });
});

describe("Observe kinds cover every market_signals.signal_type", () => {
  it("stays aligned with the desk enum", () => {
    expect(alignedMarketSignalTypes).toEqual(marketSignalTypes);
  });

  it("maps each signal type to a Pulse Observe kind", () => {
    for (const signalType of marketSignalTypes) {
      expect(observeKindFromMarketSignalType(signalType)).toBeTruthy();
    }
    expect(observeKindFromMarketSignalType("freight_rate")).toBe(
      "logistics_lane",
    );
    expect(observeKindFromMarketSignalType("commodity_index")).toBe(
      "price_index",
    );
  });
});

describe("Pulse ↔ analysis_cycles field alignment", () => {
  it("points at the existing JSONB payload columns", () => {
    expect(pulseToCycleField.observe).toBe("observe_payload");
    expect(pulseToCycleField.decide).toBe("decide_payload");
    expect(pulseToCycleField.learn).toBe("learn_payload");
    expect(cycleFieldForPulsePhase("act")).toBe("act_payload");
  });
});

describe("Diligence section IDs", () => {
  it("keeps a stable horizontal template plus edition appendix", () => {
    expect(diligenceSectionIds).toContain("diligence.edition_appendix");
    expect(diligenceSectionIds).toContain("diligence.data_fences");
    expect(diligenceHorizontalSectionIds).not.toContain(
      "diligence.edition_appendix",
    );
    expect(isDiligenceSectionId("diligence.supplier_concentration")).toBe(
      true,
    );
    expect(isDiligenceSectionId("diligence.fsa_war_stories")).toBe(false);
  });
});

describe("Layer C event parse", () => {
  const decideEvent = {
    schemaVersion: 1,
    phase: "decide",
    verticalTags: ["mro"],
    leverId: "dual_sourcing",
    decideAction: "dual_source",
    learnOutcome: null,
    ownerRole: "proc_ops",
    occurredAt: "2026-09-15T12:00:00.000Z",
    cycleId: "cyc_test",
    opportunityId: "opp_test",
    marketSignalId: null,
    tenantLocalStakeUsd: 50000,
  };

  it("accepts a well-formed Decide event", () => {
    const parsed = parsePulseLayerCEvent(decideEvent);
    expect(parsed?.decideAction).toBe("dual_source");
    expect(parsed?.verticalTags).toEqual(["mro"]);
  });

  it("requires a Learn outcome on learn phase", () => {
    expect(
      parsePulseLayerCEvent({
        ...decideEvent,
        phase: "learn",
        decideAction: null,
        learnOutcome: null,
      }),
    ).toBeNull();
    expect(
      parsePulseLayerCEvent({
        ...decideEvent,
        phase: "learn",
        decideAction: null,
        learnOutcome: "unknown",
      })?.learnOutcome,
    ).toBe("unknown");
  });

  it("rejects empty tags, bad actions, and non-finite stake", () => {
    expect(parsePulseLayerCEvent({ ...decideEvent, verticalTags: [] })).toBeNull();
    expect(
      parsePulseLayerCEvent({ ...decideEvent, decideAction: "approve" }),
    ).toBeNull();
    expect(
      parsePulseLayerCEvent({
        ...decideEvent,
        tenantLocalStakeUsd: Number.NaN,
      }),
    ).toBeNull();
  });
});
