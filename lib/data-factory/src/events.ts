/**
 * Parallel news/OSINT ingest — RSS → normalize → dedupe → event schema.
 *
 * Product payload is metadata only: title, url, published, source,
 * entities[], event_type, severity. Full article HTML / body text is
 * dropped at normalize and must never be stored or resold.
 */

import { listNewsOsintSources, type DataFactorySource } from "./catalog";
import { DATA_FACTORY_RELEASE, DATA_FACTORY_SCHEMA_VERSION } from "./status";

export const OSINT_EVENT_TYPES = [
  "policy",
  "port_disruption",
  "maritime",
  "freight",
  "hazard",
  "quake",
  "storm",
  "trade",
  "other",
] as const;
export type OsintEventType = (typeof OSINT_EVENT_TYPES)[number];

export const OSINT_SEVERITIES = [
  "info",
  "watch",
  "warning",
  "severe",
  "unknown",
] as const;
export type OsintSeverity = (typeof OSINT_SEVERITIES)[number];

export const OSINT_EVENT_FIELD_NAMES = [
  "title",
  "url",
  "published",
  "source",
  "entities",
  "event_type",
  "severity",
] as const;

/** Keys that must never appear on a product event payload. */
export const OSINT_FORBIDDEN_PAYLOAD_KEYS = [
  "html",
  "htmlBody",
  "body",
  "fullText",
  "content",
  "contentEncoded",
  "description",
  "articleHtml",
  "summary",
] as const;

export const OSINT_TOS = {
  headlinesAndLink: "ok",
  fullTextRepublish: "out_of_scope",
  storesFullArticleHtml: false,
  note:
    "Headlines + canonical link are in scope. Full-text republish, article HTML bodies, and content:encoded dumps are out of scope.",
} as const;

export interface OsintEvent {
  title: string;
  url: string;
  published: string | null;
  source: string;
  entities: string[];
  event_type: OsintEventType;
  severity: OsintSeverity;
}

export interface PulseCitedBullet {
  text: string;
  url: string;
  source: string;
  published: string | null;
}

/**
 * Parser-shaped RSS/Atom item. Extra body fields may arrive from a
 * feed parser; normalizeRssItem drops them.
 */
export interface RawRssItem {
  sourceId: string;
  title?: string;
  link?: string;
  guid?: string;
  pubDate?: string;
  updated?: string;
  entities?: string[];
  event_type?: OsintEventType;
  severity?: OsintSeverity;
  description?: string;
  content?: string;
  contentEncoded?: string;
  html?: string;
  htmlBody?: string;
  fullText?: string;
  summary?: string;
}

const EVENT_TYPE_BY_SOURCE: Record<string, OsintEventType> = {
  src_cbp_csms: "policy",
  src_federal_register: "policy",
  src_freightwaves_rss: "freight",
  src_supply_chain_dive: "freight",
  src_gcaptain: "maritime",
  src_maritime_executive: "maritime",
  src_splash247: "maritime",
  src_loadstar: "freight",
  src_container_news: "freight",
  src_bbc_business: "other",
  src_gdelt: "other",
  src_google_news_rss: "other",
  src_gdacs: "hazard",
  src_usgs_quakes: "quake",
  src_nhc_products: "storm",
};

export function canonicalizeEventUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    const drop = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];
    for (const key of drop) url.searchParams.delete(key);
    let href = url.toString();
    if (href.endsWith("/") && url.pathname === "/") {
      href = href.slice(0, -1);
    }
    return href;
  } catch {
    return null;
  }
}

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

function parsePublished(raw?: string): string | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

export function osintEventDedupeKey(event: OsintEvent): string {
  return `url:${event.url}`;
}

export function normalizeRssItem(item: RawRssItem): OsintEvent | null {
  const url = canonicalizeEventUrl(item.link ?? item.guid ?? "");
  const title = (item.title ?? "").trim();
  if (!url || !title) return null;
  const entities = (item.entities ?? []).filter((e) => e.trim().length > 0);
  return {
    title,
    url,
    published: parsePublished(item.pubDate ?? item.updated),
    source: item.sourceId,
    entities,
    event_type: item.event_type ?? EVENT_TYPE_BY_SOURCE[item.sourceId] ?? "other",
    severity: item.severity ?? "unknown",
  };
}

export function dedupeEvents(events: OsintEvent[]): OsintEvent[] {
  const seen = new Set<string>();
  const out: OsintEvent[] = [];
  for (const event of events) {
    const key = osintEventDedupeKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(event);
  }
  return out;
}

export function ingestRssItems(items: RawRssItem[]): OsintEvent[] {
  return dedupeEvents(
    items.flatMap((item) => {
      const event = normalizeRssItem(item);
      return event ? [event] : [];
    }),
  );
}

export function eventHasForbiddenPayloadKeys(value: object): boolean {
  return OSINT_FORBIDDEN_PAYLOAD_KEYS.some((key) =>
    Object.prototype.hasOwnProperty.call(value, key),
  );
}

export function toPulseCitedBullets(events: OsintEvent[]): PulseCitedBullet[] {
  return events.map((event) => ({
    text: event.title,
    url: event.url,
    source: event.source,
    published: event.published,
  }));
}

export function osintEventSchemaFields(): Array<{
  name: (typeof OSINT_EVENT_FIELD_NAMES)[number];
  type: "string" | "string[]";
  required: boolean;
  note: string;
}> {
  return [
    { name: "title", type: "string", required: true, note: "Headline only" },
    { name: "url", type: "string", required: true, note: "Canonical article / product URL" },
    { name: "published", type: "string", required: false, note: "ISO-8601 when the feed has a date" },
    { name: "source", type: "string", required: true, note: "Catalog source id" },
    { name: "entities", type: "string[]", required: true, note: "Named ports/firms/places when extracted; else []" },
    { name: "event_type", type: "string", required: true, note: OSINT_EVENT_TYPES.join(" | ") },
    { name: "severity", type: "string", required: true, note: OSINT_SEVERITIES.join(" | ") },
  ];
}

export interface NewsOsintStream {
  schemaVersion: typeof DATA_FACTORY_SCHEMA_VERSION;
  release: typeof DATA_FACTORY_RELEASE;
  ga: false;
  layer: "A";
  track: "news_osint";
  tos: typeof OSINT_TOS;
  schema: {
    recordName: "OsintEvent";
    fields: ReturnType<typeof osintEventSchemaFields>;
    liveFetch: false;
    storesFullArticleHtml: false;
  };
  sources: DataFactorySource[];
  events: OsintEvent[];
  pulse: {
    format: "cited_bullets";
    citedBullets: PulseCitedBullet[];
  };
  fences: string[];
}

const NEWS_OSINT_FENCES = [
  "Headlines + link OK. Full-text republish is out of scope.",
  "Do not store or resell full article HTML bodies as product payloads.",
  "Google News RSS is an optional fragile sensor — not a GA dependency.",
  "No invented events, TEU, indexes, or customer metrics.",
  "No tenant spend or FSA client files.",
];

export function newsOsintMetadataStream(
  events: OsintEvent[] = [],
): NewsOsintStream {
  for (const event of events) {
    if (eventHasForbiddenPayloadKeys(event)) {
      throw new Error("OSINT event leaked a full-text / HTML field");
    }
  }
  return {
    schemaVersion: DATA_FACTORY_SCHEMA_VERSION,
    release: DATA_FACTORY_RELEASE,
    ga: false,
    layer: "A",
    track: "news_osint",
    tos: OSINT_TOS,
    schema: {
      recordName: "OsintEvent",
      fields: osintEventSchemaFields(),
      liveFetch: false,
      storesFullArticleHtml: false,
    },
    sources: listNewsOsintSources(),
    events,
    pulse: {
      format: "cited_bullets",
      citedBullets: toPulseCitedBullets(events),
    },
    fences: NEWS_OSINT_FENCES,
  };
}
