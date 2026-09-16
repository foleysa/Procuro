/**
 * Optional post-write hooks. Collectors write first; analysis is later.
 *
 *   - Pub/Sub: notify that new news_events / market_signals landed
 *   - Gemini Orient: optional Pulse summary of metadata events
 *   - Vertex Agent Engine: explicitly deferred — do not block Day 0
 *
 * Every hook no-ops unless its env is set. None invent events.
 */

import type { OsintEvent } from "./events";

export const DATA_FACTORY_VERTEX_AGENTS = {
  status: "deferred",
  reason:
    "Agents/analysis run AFTER collectors write data. Vertex Agent Engine is out of Day 0 scope.",
} as const;

export type HookSkipReason =
  | "optional_unconfigured"
  | "empty_batch"
  | "gcp_unavailable"
  | "deferred";

export interface HookSkip {
  status: "skipped";
  reason: HookSkipReason;
  note: string;
}

export interface PubSubPublishResult extends HookSkip {
  topic: string | null;
  publishedCount: 0;
}

function pubsubTopic(): string | undefined {
  return (
    process.env["DATA_FACTORY_PUBSUB_TOPIC"]?.trim() ||
    process.env["INTELLIGENCE_PUBSUB_TOPIC"]?.trim() ||
    undefined
  );
}

/**
 * Optional Pub/Sub topic for newly persisted news events.
 * No-ops when DATA_FACTORY_PUBSUB_TOPIC / INTELLIGENCE_PUBSUB_TOPIC
 * is unset, or when @google-cloud/pubsub is not installed.
 */
export async function publishNewsEventsHook(
  events: readonly OsintEvent[],
): Promise<PubSubPublishResult> {
  const topic = pubsubTopic() ?? null;
  if (!topic) {
    return {
      status: "skipped",
      reason: "optional_unconfigured",
      topic: null,
      publishedCount: 0,
      note: "Set DATA_FACTORY_PUBSUB_TOPIC to enable. Collectors write without it.",
    };
  }
  if (events.length === 0) {
    return {
      status: "skipped",
      reason: "empty_batch",
      topic,
      publishedCount: 0,
      note: "No events to publish.",
    };
  }
  try {
    const mod = (await import("@google-cloud/pubsub")) as {
      PubSub?: new (opts: { projectId?: string }) => {
        topic(name: string): { publishMessage(msg: { json: unknown }): Promise<string> };
      };
    };
    if (!mod.PubSub) {
      return {
        status: "skipped",
        reason: "gcp_unavailable",
        topic,
        publishedCount: 0,
        note: "@google-cloud/pubsub not available.",
      };
    }
  } catch {
    return {
      status: "skipped",
      reason: "gcp_unavailable",
      topic,
      publishedCount: 0,
      note: "@google-cloud/pubsub not installed — hook is optional.",
    };
  }
  // Day 0: do not actually publish invented or live payloads.
  return {
    status: "skipped",
    reason: "optional_unconfigured",
    topic,
    publishedCount: 0,
    note: "Pub/Sub client resolved but Day 0 stub does not publish until collectors write live rows.",
  };
}

export interface OrientSummaryResult {
  status: "skipped" | "ok";
  reason?: HookSkipReason;
  summary: string | null;
  model: string | null;
  note: string;
}

function geminiConfigured(): boolean {
  return Boolean(
    process.env["AI_INTEGRATIONS_GEMINI_API_KEY"]?.trim() &&
      process.env["AI_INTEGRATIONS_GEMINI_BASE_URL"]?.trim(),
  );
}

/**
 * Optional Gemini Orient summary over *already-written* metadata events.
 * Uses the same env as `@workspace/integrations-gemini-ai` (`@google/genai`)
 * but does not throw at import time — unconfigured = skip.
 *
 * Does not fetch or summarize article HTML.
 */
export async function summarizeEventsForOrient(
  events: readonly OsintEvent[],
): Promise<OrientSummaryResult> {
  if (!geminiConfigured()) {
    return {
      status: "skipped",
      reason: "optional_unconfigured",
      summary: null,
      model: null,
      note: "Set AI_INTEGRATIONS_GEMINI_API_KEY + AI_INTEGRATIONS_GEMINI_BASE_URL to enable. Optional.",
    };
  }
  if (events.length === 0) {
    return {
      status: "skipped",
      reason: "empty_batch",
      summary: null,
      model: null,
      note: "Orient runs after collectors write events.",
    };
  }
  const headlines = events.map((e) => `- ${e.title} (${e.url})`).join("\n");
  try {
    const { GoogleGenAI } = (await import("@google/genai")) as {
      GoogleGenAI: new (opts: {
        apiKey: string;
        httpOptions?: { apiVersion?: string; baseUrl?: string };
      }) => {
        models: {
          generateContent(args: {
            model: string;
            contents: string;
          }): Promise<{ text?: string }>;
        };
      };
    };
    const ai = new GoogleGenAI({
      apiKey: process.env["AI_INTEGRATIONS_GEMINI_API_KEY"]!,
      httpOptions: {
        apiVersion: "",
        baseUrl: process.env["AI_INTEGRATIONS_GEMINI_BASE_URL"],
      },
    });
    const model = "gemini-2.0-flash";
    const response = await ai.models.generateContent({
      model,
      contents:
        "Orient brief from headlines + links only. Do not invent facts.\n" +
        headlines,
    });
    return {
      status: "ok",
      summary: response.text ?? "",
      model,
      note: "Gemini Orient over metadata events. No article HTML.",
    };
  } catch {
    return {
      status: "skipped",
      reason: "optional_unconfigured",
      summary: null,
      model: null,
      note: "@google/genai unavailable or call failed — Orient is optional.",
    };
  }
}

export function vertexAgentEngineStatus(): typeof DATA_FACTORY_VERTEX_AGENTS {
  return DATA_FACTORY_VERTEX_AGENTS;
}
