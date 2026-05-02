/**
 * Natural-hazards collector — combined USGS earthquakes + NOAA NWS
 * weather alerts + NASA EONET natural events + GDACS multi-hazard
 * disasters into one geocoded `natural_hazard` MarketSignal stream.
 *
 * Sources:
 *   - USGS earthquakes (last hour, M4.5+):
 *       https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_hour.geojson
 *   - NOAA NWS active alerts (US):
 *       https://api.weather.gov/alerts/active
 *   - NASA EONET v3 events (open, last 7d):
 *       https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=7
 *   - GDACS RSS (global multi-hazard alerts):
 *       https://www.gdacs.org/xml/rss.xml
 *
 * Each draft uses:
 *   - `signal_type` = `natural_hazard`
 *   - `scope_sku`   = source-specific event id (uniqueness)
 *   - `scope_lane_key` = country / region code
 *   - `value`       = source code (1=USGS, 2=NWS, 3=EONET, 4=GDACS)
 *   - metadata.severity / magnitude in source-specific field
 *
 * Posture: `public_api`, tier `T1`. All four are official open
 * government feeds.
 *
 * Partial-outage: if at least one source returns rows, the run
 * succeeds. Only failure is when all four sources error.
 */

import { z } from "zod";
import {
  buildSignalDraftSchema,
  defaultStableSignalKey,
} from "../contractHelpers";
import type {
  CollectWithRawResult,
  IntelligenceCollector,
  MarketSignalDraft,
  RawPayload,
} from "../collector";
import { logger } from "../../logger";

export const NATURAL_HAZARDS_COLLECTOR_ID = "natural-hazards";

export const HAZARD_SOURCE_CODES = {
  USGS: 1,
  NWS: 2,
  EONET: 3,
  GDACS: 4,
} as const;

const HAZARD_SOURCES = {
  USGS: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_hour.geojson",
  NWS: "https://api.weather.gov/alerts/active",
  EONET: "https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=7",
  GDACS: "https://www.gdacs.org/xml/rss.xml",
} as const;

// -- USGS earthquakes ----------------------------------------------------

export interface UsgsFeed {
  features?: Array<{
    id?: string;
    properties?: {
      mag?: number;
      place?: string;
      time?: number;
      url?: string;
      type?: string;
      tsunami?: number;
    };
    geometry?: { coordinates?: number[] };
  }>;
}

export function parseUsgsFeed(feed: UsgsFeed): MarketSignalDraft[] {
  const drafts: MarketSignalDraft[] = [];
  for (const f of feed.features ?? []) {
    if (!f.id) continue;
    const mag = f.properties?.mag;
    if (typeof mag !== "number" || !Number.isFinite(mag)) continue;
    const time = f.properties?.time;
    if (typeof time !== "number") continue;
    const observedAt = new Date(time);
    if (Number.isNaN(observedAt.getTime())) continue;
    const coords = f.geometry?.coordinates ?? [];
    drafts.push({
      signalType: "natural_hazard",
      scopeSku: f.id,
      scopeLaneKey: extractCountryHint(f.properties?.place),
      scopeCategoryCode: f.properties?.type ?? "earthquake",
      value: HAZARD_SOURCE_CODES.USGS,
      unit: "source_code",
      currency: "USD",
      observedAt,
      sourceUrl: f.properties?.url ?? HAZARD_SOURCES.USGS,
      confidence: 0.99,
      metadata: {
        sourceName: "USGS",
        eventId: f.id,
        magnitude: mag,
        place: f.properties?.place ?? null,
        eventType: f.properties?.type ?? "earthquake",
        tsunami: f.properties?.tsunami ?? 0,
        longitude: typeof coords[0] === "number" ? coords[0] : null,
        latitude: typeof coords[1] === "number" ? coords[1] : null,
        depthKm: typeof coords[2] === "number" ? coords[2] : null,
      },
    });
  }
  return drafts;
}

function extractCountryHint(place: string | undefined | null): string | undefined {
  if (!place) return undefined;
  // USGS format: "20 km E of Tegucigalpa, Honduras". Last comma-segment
  // is usually the country/region.
  const parts = place.split(",");
  const tail = parts[parts.length - 1];
  return tail ? tail.trim() : undefined;
}

// -- NOAA NWS alerts -----------------------------------------------------

export interface NwsAlertsResponse {
  features?: Array<{
    id?: string;
    properties?: {
      id?: string;
      event?: string;
      severity?: string;
      certainty?: string;
      urgency?: string;
      sent?: string;
      effective?: string;
      areaDesc?: string;
      headline?: string;
      messageType?: string;
    };
  }>;
}

export const NWS_SEVERITY_VALUES: Record<string, number> = {
  Minor: 1,
  Moderate: 2,
  Severe: 3,
  Extreme: 4,
  Unknown: 0,
};

export function parseNwsAlerts(payload: NwsAlertsResponse): MarketSignalDraft[] {
  const drafts: MarketSignalDraft[] = [];
  for (const f of payload.features ?? []) {
    const id = f.id ?? f.properties?.id;
    if (!id) continue;
    const sentStr = f.properties?.sent ?? f.properties?.effective;
    const observedAt = sentStr ? new Date(sentStr) : new Date();
    if (Number.isNaN(observedAt.getTime())) continue;
    drafts.push({
      signalType: "natural_hazard",
      scopeSku: id,
      scopeLaneKey: "US",
      scopeCategoryCode: f.properties?.event ?? "weather_alert",
      value: HAZARD_SOURCE_CODES.NWS,
      unit: "source_code",
      currency: "USD",
      observedAt,
      sourceUrl: id,
      confidence: 0.95,
      metadata: {
        sourceName: "NWS",
        eventId: id,
        event: f.properties?.event ?? null,
        severity: f.properties?.severity ?? null,
        severityValue:
          NWS_SEVERITY_VALUES[f.properties?.severity ?? "Unknown"] ?? 0,
        certainty: f.properties?.certainty ?? null,
        urgency: f.properties?.urgency ?? null,
        areaDesc: f.properties?.areaDesc ?? null,
        headline: f.properties?.headline ?? null,
        messageType: f.properties?.messageType ?? null,
      },
    });
  }
  return drafts;
}

// -- NASA EONET ----------------------------------------------------------

export interface EonetResponse {
  events?: Array<{
    id?: string;
    title?: string;
    closed?: string | null;
    categories?: Array<{ id?: string; title?: string }>;
    sources?: Array<{ id?: string; url?: string }>;
    geometry?: Array<{ date?: string; coordinates?: number[]; magnitudeValue?: number; magnitudeUnit?: string }>;
  }>;
}

export function parseEonetEvents(payload: EonetResponse): MarketSignalDraft[] {
  const drafts: MarketSignalDraft[] = [];
  for (const e of payload.events ?? []) {
    if (!e.id) continue;
    const lastGeom = (e.geometry ?? []).at(-1);
    const observedAt = lastGeom?.date ? new Date(lastGeom.date) : new Date();
    if (Number.isNaN(observedAt.getTime())) continue;
    const category = e.categories?.[0]?.title ?? "natural_event";
    const lon = lastGeom?.coordinates?.[0];
    const lat = lastGeom?.coordinates?.[1];
    drafts.push({
      signalType: "natural_hazard",
      scopeSku: e.id,
      scopeCategoryCode: category,
      value: HAZARD_SOURCE_CODES.EONET,
      unit: "source_code",
      currency: "USD",
      observedAt,
      sourceUrl:
        e.sources?.[0]?.url ?? `https://eonet.gsfc.nasa.gov/api/v3/events/${e.id}`,
      confidence: 0.9,
      metadata: {
        sourceName: "EONET",
        eventId: e.id,
        title: e.title ?? null,
        closed: e.closed ?? null,
        category,
        categoryId: e.categories?.[0]?.id ?? null,
        magnitudeValue: lastGeom?.magnitudeValue ?? null,
        magnitudeUnit: lastGeom?.magnitudeUnit ?? null,
        longitude: typeof lon === "number" ? lon : null,
        latitude: typeof lat === "number" ? lat : null,
      },
    });
  }
  return drafts;
}

// -- GDACS RSS -----------------------------------------------------------

export interface GdacsItem {
  id: string;
  title: string;
  link: string;
  pubDate: Date;
  alertLevel: string | null;
  country: string | null;
  eventType: string | null;
}

/**
 * Crude RSS parser — pulls each <item>...</item>, extracts the four
 * GDACS namespaced tags we care about. Sufficient for the well-formed
 * GDACS feed; falls back to null fields on missing tags.
 */
export function parseGdacsRss(xml: string): GdacsItem[] {
  const items: GdacsItem[] = [];
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  for (const block of blocks) {
    const title = extract(block, "title");
    const link = extract(block, "link");
    const guid = extract(block, "guid");
    const pubDateStr = extract(block, "pubDate");
    if (!title || !link || !pubDateStr) continue;
    const pubDate = new Date(pubDateStr);
    if (Number.isNaN(pubDate.getTime())) continue;
    items.push({
      id: guid ?? link,
      title,
      link,
      pubDate,
      alertLevel: extract(block, "gdacs:alertlevel"),
      country: extract(block, "gdacs:country"),
      eventType: extract(block, "gdacs:eventtype"),
    });
  }
  return items;
}

export const GDACS_ALERT_VALUES: Record<string, number> = {
  Green: 1,
  Orange: 2,
  Red: 3,
};

export function gdacsItemToDraft(item: GdacsItem): MarketSignalDraft {
  return {
    signalType: "natural_hazard",
    scopeSku: item.id,
    scopeLaneKey: item.country ?? undefined,
    scopeCategoryCode: item.eventType ?? "disaster_alert",
    value: HAZARD_SOURCE_CODES.GDACS,
    unit: "source_code",
    currency: "USD",
    observedAt: item.pubDate,
    sourceUrl: item.link,
    confidence: 0.9,
    metadata: {
      sourceName: "GDACS",
      eventId: item.id,
      title: item.title,
      alertLevel: item.alertLevel,
      alertValue: item.alertLevel ? (GDACS_ALERT_VALUES[item.alertLevel] ?? 0) : 0,
      country: item.country,
      eventType: item.eventType,
    },
  };
}

function extract(block: string, tag: string): string | null {
  // Allow CDATA-wrapped values too.
  const re = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`);
  const m = block.match(re);
  if (!m || !m[1]) return null;
  const v = m[1].trim();
  return v.length > 0 ? v : null;
}

// -- Combined collector --------------------------------------------------

const hazardMetadataSchema = z
  .object({
    sourceName: z.enum(["USGS", "NWS", "EONET", "GDACS"]),
    eventId: z.string().min(1),
  })
  .passthrough();

const hazardSignalSchema = buildSignalDraftSchema(hazardMetadataSchema);

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<{ payload: T; body: string }> {
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Procuro Procurement Platform compliance@procuro.ai",
    },
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const body = await res.text();
  return { payload: JSON.parse(body) as T, body };
}

async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Procuro Procurement Platform" },
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

export const naturalHazardsCollector: IntelligenceCollector<typeof hazardSignalSchema> = {
  id: NATURAL_HAZARDS_COLLECTOR_ID,
  name: "Natural Hazards (USGS / NWS / EONET / GDACS)",
  description:
    "Combined natural-hazards collector. Pulls USGS M4.5+ earthquakes (last hour), NOAA NWS active US weather alerts, NASA EONET open natural events (7d), and GDACS multi-hazard RSS into one natural_hazard MarketSignal stream.",
  posture: "public-api",
  sourceUrl: "https://earthquake.usgs.gov/",
  defaultRateLimitRpm: 60,
  defaultScheduleCron: "*/15 * * * *",
  postureClass: "public_api",
  disclosureTier: "T1",
  jurisdiction: "GLOBAL",
  retentionDays: 365,
  tenantOptInDefault: true,
  signalSchema: hazardSignalSchema,
  stableSignalKey(draft) {
    return defaultStableSignalKey(NATURAL_HAZARDS_COLLECTOR_ID, draft);
  },
  async collect({ signal } = { since: null }): Promise<MarketSignalDraft[]> {
    return (await this.collectWithRaw!({ since: null, signal })).drafts;
  },
  async collectWithRaw({ signal } = { since: null }): Promise<CollectWithRawResult> {
    const drafts: MarketSignalDraft[] = [];
    const rawPayloads: RawPayload[] = [];
    const failures: string[] = [];
    type Source = {
      key: keyof typeof HAZARD_SOURCES;
      contentType: string;
      run: () => Promise<{ drafts: MarketSignalDraft[]; body: string }>;
    };
    const sources: Source[] = [
      {
        key: "USGS",
        contentType: "application/geo+json",
        run: async () => {
          const { payload, body } = await fetchJson<UsgsFeed>(HAZARD_SOURCES.USGS, signal);
          return { drafts: parseUsgsFeed(payload), body };
        },
      },
      {
        key: "NWS",
        contentType: "application/geo+json",
        run: async () => {
          const { payload, body } = await fetchJson<NwsAlertsResponse>(
            HAZARD_SOURCES.NWS,
            signal,
          );
          return { drafts: parseNwsAlerts(payload), body };
        },
      },
      {
        key: "EONET",
        contentType: "application/json",
        run: async () => {
          const { payload, body } = await fetchJson<EonetResponse>(
            HAZARD_SOURCES.EONET,
            signal,
          );
          return { drafts: parseEonetEvents(payload), body };
        },
      },
      {
        key: "GDACS",
        contentType: "application/rss+xml",
        run: async () => {
          const body = await fetchText(HAZARD_SOURCES.GDACS, signal);
          return {
            drafts: parseGdacsRss(body).map(gdacsItemToDraft),
            body,
          };
        },
      },
    ];
    for (const s of sources) {
      try {
        const { drafts: d, body } = await s.run();
        for (const x of d) drafts.push(x);
        rawPayloads.push({
          name: `natural-hazards-${s.key.toLowerCase()}`,
          contentType: s.contentType,
          body,
          sourceUrl: HAZARD_SOURCES[s.key],
          metadata: { sourceName: s.key, drafts: d.length },
        });
      } catch (err) {
        failures.push(`${s.key}: ${err instanceof Error ? err.message : String(err)}`);
        logger.warn(
          { collectorId: NATURAL_HAZARDS_COLLECTOR_ID, source: s.key, err },
          "Hazard source failed",
        );
      }
    }
    if (drafts.length === 0 && failures.length === sources.length) {
      throw new Error(
        `natural-hazards: all four sources failed. Sample: ${failures.slice(0, 2).join("; ")}`,
      );
    }
    return { drafts, rawPayloads };
  },
};
