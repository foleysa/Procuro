import { describe, it, expect } from "vitest";
import { gateSlaBreach } from "../src/doa-config";

function makeScenario(
  slaHours: number,
  offsetMs: number,
): { stageEnteredAt: Date; nowMs: number } {
  const nowMs = Date.now();
  const elapsed = slaHours * 60 * 60 * 1000 + offsetMs;
  return { stageEnteredAt: new Date(nowMs - elapsed), nowMs };
}

describe("gateSlaBreach", () => {
  const forwardStages: Array<{ stage: string; slaHours: number }> = [
    { stage: "Identified", slaHours: 72 },
    { stage: "Awarded", slaHours: 120 },
    { stage: "In Contracting", slaHours: 168 },
    { stage: "In Implementation", slaHours: 720 },
  ];

  for (const { stage, slaHours } of forwardStages) {
    describe(`${stage} (SLA: ${slaHours}h)`, () => {
      it("under SLA → not breaching", () => {
        const { stageEnteredAt, nowMs } = makeScenario(slaHours, -3600_000);
        const result = gateSlaBreach({
          canonicalStage: stage,
          stageEnteredAt,
          nowMs,
        });
        expect(result.breaching).toBe(false);
        expect(result.slaHours).toBe(slaHours);
      });

      it("at exactly the SLA boundary → not breaching", () => {
        const { stageEnteredAt, nowMs } = makeScenario(slaHours, 0);
        const result = gateSlaBreach({
          canonicalStage: stage,
          stageEnteredAt,
          nowMs,
        });
        expect(result.breaching).toBe(false);
      });

      it("1 ms over SLA → breaching", () => {
        const { stageEnteredAt, nowMs } = makeScenario(slaHours, 1);
        const result = gateSlaBreach({
          canonicalStage: stage,
          stageEnteredAt,
          nowMs,
        });
        expect(result.breaching).toBe(true);
      });
    });
  }

  describe("terminal stages", () => {
    it("Realized → never breaches", () => {
      const result = gateSlaBreach({
        canonicalStage: "Realized",
        stageEnteredAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
      });
      expect(result.breaching).toBe(false);
      expect(result.slaHours).toBeNull();
    });

    it("Closed-No Action → never breaches", () => {
      const result = gateSlaBreach({
        canonicalStage: "Closed-No Action",
        stageEnteredAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
      });
      expect(result.breaching).toBe(false);
      expect(result.slaHours).toBeNull();
    });
  });

  describe("edge cases", () => {
    it("null stageEnteredAt → not breaching", () => {
      const result = gateSlaBreach({
        canonicalStage: "Identified",
        stageEnteredAt: null,
      });
      expect(result.breaching).toBe(false);
    });

    it("null canonicalStage → not breaching", () => {
      const result = gateSlaBreach({
        canonicalStage: null,
        stageEnteredAt: new Date(),
      });
      expect(result.breaching).toBe(false);
      expect(result.slaHours).toBeNull();
    });
  });
});
