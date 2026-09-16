import { describe, expect, it } from "vitest";
import {
  DATA_FACTORY_VERTEX_AGENTS,
  publishNewsEventsHook,
  summarizeEventsForOrient,
  vertexAgentEngineStatus,
} from "../src/hooks";

describe("optional post-write hooks", () => {
  it("skips Pub/Sub when no topic is configured", async () => {
    const prior = process.env["DATA_FACTORY_PUBSUB_TOPIC"];
    const priorIntel = process.env["INTELLIGENCE_PUBSUB_TOPIC"];
    delete process.env["DATA_FACTORY_PUBSUB_TOPIC"];
    delete process.env["INTELLIGENCE_PUBSUB_TOPIC"];
    const result = await publishNewsEventsHook([
      {
        title: "x",
        url: "https://example.com/x",
        published: null,
        source: "src_gcaptain",
        entities: [],
        event_type: "maritime",
        severity: "unknown",
      },
    ]);
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("optional_unconfigured");
    expect(result.publishedCount).toBe(0);
    if (prior !== undefined) process.env["DATA_FACTORY_PUBSUB_TOPIC"] = prior;
    if (priorIntel !== undefined) {
      process.env["INTELLIGENCE_PUBSUB_TOPIC"] = priorIntel;
    }
  });

  it("skips Gemini Orient when the existing genai env is unset", async () => {
    const key = process.env["AI_INTEGRATIONS_GEMINI_API_KEY"];
    const base = process.env["AI_INTEGRATIONS_GEMINI_BASE_URL"];
    delete process.env["AI_INTEGRATIONS_GEMINI_API_KEY"];
    delete process.env["AI_INTEGRATIONS_GEMINI_BASE_URL"];
    const result = await summarizeEventsForOrient([]);
    expect(result.status).toBe("skipped");
    expect(result.summary).toBeNull();
    expect(result.note).toMatch(/optional/i);
    if (key !== undefined) process.env["AI_INTEGRATIONS_GEMINI_API_KEY"] = key;
    if (base !== undefined) process.env["AI_INTEGRATIONS_GEMINI_BASE_URL"] = base;
  });

  it("does not block Day 0 on Vertex Agent Engine", () => {
    expect(vertexAgentEngineStatus()).toEqual(DATA_FACTORY_VERTEX_AGENTS);
    expect(DATA_FACTORY_VERTEX_AGENTS.status).toBe("deferred");
    expect(DATA_FACTORY_VERTEX_AGENTS.reason).toMatch(/AFTER collectors write/i);
  });
});
