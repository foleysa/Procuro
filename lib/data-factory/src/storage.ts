/**
 * Locked Data Factory storage layout (John confirmed).
 *
 * Prefer the existing `@workspace/intelligence` GCS + BigQuery helpers
 * and Drizzle `market_signals` / `data_factory_*` schemas. Do not invent
 * a second bucket, dataset, or warehouse.
 *
 * Agents / Vertex Agent Engine run AFTER collectors write. They do not
 * block this PR.
 */

import {
  landRawPayload,
  rawPayloadPath,
  type LandPayloadResult,
} from "@workspace/intelligence/gcs";
import type { OsintEvent } from "./events";

export const DATA_FACTORY_STORAGE_LAYOUT = {
  gcs: {
    role: "raw_landing",
    reuse: "INTELLIGENCE_GCS_RAW_BUCKET",
    aliases: ["INTELLIGENCE_GCS_RAW_BUCKET", "GCS_RAW_BUCKET"],
    pathPattern: "gs://<bucket>/<collectorId>/<YYYY/MM/DD>/<runId>.<ext>",
    helper: "landRawPayload (@workspace/intelligence/gcs)",
    newsLanding: "RSS/Atom/JSON bytes only — never article HTML bodies",
  },
  postgres: {
    role: "serving",
    tables: {
      market_signals: "Existing collector serving fact (do not dump tenant spend)",
      news_events: "OSINT metadata only (title/url/published/source/entities/event_type/severity)",
      data_factory_usage_log: "API metering hook — not a GA billing meter",
      data_factory_layer_c_labels: "Decide→Learn on public signals",
    },
  },
  bigquery: {
    role: "analytics_history",
    reuse: "market_signals_warehouse (INTELLIGENCE_BQ_DATASET)",
    tables: ["market_signals", "collector_runs", "entities", "news_events"],
    gdeltJoins:
      "news_events.url LEFT JOIN market_signals where signal_type in (event_geocoded, entity_news_event)",
    when: "GCP available — helpers no-op locally/CI",
  },
} as const;

export const NEWS_EVENTS_FORBIDDEN_COLUMNS = [
  "html",
  "html_body",
  "body",
  "full_text",
  "content",
  "content_encoded",
  "article_html",
  "summary",
] as const;

const FORBIDDEN_NEWS_LANDING = new Set([
  "html",
  "htm",
  "text/html",
  "application/xhtml+xml",
]);

export function dataFactoryRawCollectorId(sourceId: string): string {
  return `df_${sourceId.replace(/[^a-z0-9_-]/gi, "_")}`;
}

export function assertNewsLandingAllowed(args: {
  extension?: string;
  contentType?: string;
}): void {
  const ext = (args.extension ?? "").replace(/^\./, "").toLowerCase();
  const type = (args.contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (FORBIDDEN_NEWS_LANDING.has(ext) || FORBIDDEN_NEWS_LANDING.has(type)) {
    throw new Error(
      "News/OSINT raw landing refuses article HTML. Store RSS/Atom/JSON metadata feeds only.",
    );
  }
}

/**
 * Land collector/RSS bytes on the existing intelligence raw bucket.
 * No-ops (returns null) when GCP is not configured — same contract as
 * `landRawPayload`.
 */
export async function landDataFactoryRaw(args: {
  sourceId: string;
  runId: string;
  observedAt: Date;
  payload: Buffer | string;
  contentType?: string;
  extension?: string;
}): Promise<LandPayloadResult | null> {
  assertNewsLandingAllowed(args);
  return landRawPayload({
    collectorId: dataFactoryRawCollectorId(args.sourceId),
    runId: args.runId,
    observedAt: args.observedAt,
    payload: args.payload,
    contentType: args.contentType,
    extension: args.extension ?? "xml",
    metadata: { track: "data-factory", sourceId: args.sourceId },
  });
}

export function dataFactoryRawPath(args: {
  sourceId: string;
  runId: string;
  observedAt: Date;
  extension?: string;
}): string {
  return rawPayloadPath({
    collectorId: dataFactoryRawCollectorId(args.sourceId),
    runId: args.runId,
    observedAt: args.observedAt,
    extension: args.extension ?? "xml",
  });
}

export interface NewsEventServingRow {
  id: string;
  sourceId: string;
  title: string;
  url: string;
  published: string | null;
  entities: string[];
  eventType: string;
  severity: string;
  rawPayloadPointer: string | null;
}

export function toNewsEventServingRow(
  event: OsintEvent,
  extra: { id: string; rawPayloadPointer?: string | null },
): NewsEventServingRow {
  return {
    id: extra.id,
    sourceId: event.source,
    title: event.title,
    url: event.url,
    published: event.published,
    entities: event.entities,
    eventType: event.event_type,
    severity: event.severity,
    rawPayloadPointer: extra.rawPayloadPointer ?? null,
  };
}
