/**
 * GDELT 2.0 Events collector — geocoded global event firehose.
 *
 * Pulls the latest 15-minute "events" CSV from
 *   https://data.gdeltproject.org/gdeltv2/lastupdate.txt
 * which lists three current bundle URLs (events / mentions / gkg).
 * We only ingest the events file; each row is one geocoded event with
 * actor, action, location, and tone.
 *
 * Why these fields:
 *   - GLOBALEVENTID:    stable per-event identifier (used as scope_sku)
 *   - EventCode (CAMEO):numeric event category, used as draft.value
 *   - GoldsteinScale:   directional valence in metadata
 *   - AvgTone:          sentiment in metadata
 *   - Action geo:       lat/lon + country code in metadata for hazard /
 *                       supply-chain disruption analyzers
 *
 * Posture: `public_api`, tier `T2`. GDELT is a research-grade dataset
 * with broad use rights; we cite the GDELT Project URL.
 *
 * GDELT publishes ~250k events per 15-min window. We hard-cap the
 * collector to `GDELT_MAX_EVENTS_PER_RUN` (default 500) of the most
 * recent rows to keep the run cheap; tenant-specific entity filtering
 * happens downstream in the Fusion Center.
 */

import { z } from "zod";
import { gunzipSync } from "node:zlib";
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

export const GDELT_EVENTS_COLLECTOR_ID = "gdelt-events";

const GDELT_LASTUPDATE_URL = "https://data.gdeltproject.org/gdeltv2/lastupdate.txt";

/** Hard ceiling on how many rows we keep per run, to stay cheap. */
export const GDELT_MAX_EVENTS_PER_RUN = 500;

/** GDELT 2.0 event-table column order (subset we use; positional). */
export const GDELT_EVENT_COLS = {
  GLOBALEVENTID: 0,
  SQLDATE: 1,
  Actor1Name: 6,
  Actor1CountryCode: 7,
  Actor2Name: 16,
  Actor2CountryCode: 17,
  EventCode: 26,
  GoldsteinScale: 30,
  NumMentions: 31,
  AvgTone: 34,
  ActionGeo_FullName: 50,
  ActionGeo_CountryCode: 51,
  ActionGeo_Lat: 56,
  ActionGeo_Long: 57,
  DATEADDED: 59,
  SOURCEURL: 60,
} as const;

/**
 * Parse the `lastupdate.txt` body — three lines, each
 * `<sha1>  <length>  <url>` for events / mentions / gkg respectively.
 * We return only the events URL (first line).
 */
export function parseLastUpdateForEventsUrl(body: string): string | null {
  const line = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0 && l.includes(".export.CSV"));
  if (!line) return null;
  const parts = line.split(/\s+/);
  const url = parts[parts.length - 1] ?? null;
  // GDELT's lastupdate.txt embeds http:// links even when served over
  // https. Force https so the subsequent fetch is not downgraded
  // (#320 — security baseline finding from #309 CI/CD scanning).
  if (url && url.startsWith("http://")) {
    return "https://" + url.slice("http://".length);
  }
  return url;
}

/**
 * Parse a GDELT 2.0 events CSV (tab-separated, despite the .CSV
 * extension) into MarketSignalDrafts. Skips rows without a parseable
 * event id or DATEADDED timestamp.
 *
 * Hard-capped at `GDELT_MAX_EVENTS_PER_RUN` rows.
 */
export function parseGdeltEvents(csv: string, sourceUrl: string): MarketSignalDraft[] {
  const drafts: MarketSignalDraft[] = [];
  const lines = csv.split(/\r?\n/);
  for (const raw of lines) {
    if (drafts.length >= GDELT_MAX_EVENTS_PER_RUN) break;
    const line = raw.trim();
    if (!line) continue;
    const cols = line.split("\t");
    if (cols.length < GDELT_EVENT_COLS.SOURCEURL + 1) continue;
    const eventId = cols[GDELT_EVENT_COLS.GLOBALEVENTID];
    const dateAdded = cols[GDELT_EVENT_COLS.DATEADDED];
    const eventCodeStr = cols[GDELT_EVENT_COLS.EventCode];
    if (!eventId || !dateAdded || !eventCodeStr) continue;
    const eventCode = Number(eventCodeStr);
    if (!Number.isFinite(eventCode)) continue;
    // DATEADDED is YYYYMMDDHHMMSS.
    if (!/^\d{14}$/.test(dateAdded)) continue;
    const observedAt = new Date(
      `${dateAdded.slice(0, 4)}-${dateAdded.slice(4, 6)}-${dateAdded.slice(6, 8)}T${dateAdded.slice(8, 10)}:${dateAdded.slice(10, 12)}:${dateAdded.slice(12, 14)}Z`,
    );
    if (Number.isNaN(observedAt.getTime())) continue;
    const country = cols[GDELT_EVENT_COLS.ActionGeo_CountryCode] || null;
    const upstreamUrl = cols[GDELT_EVENT_COLS.SOURCEURL] || sourceUrl;
    const actor1 = cols[GDELT_EVENT_COLS.Actor1Name] || null;
    const actor2 = cols[GDELT_EVENT_COLS.Actor2Name] || null;
    drafts.push({
      signalType: "event_geocoded",
      // Park country at scope_lane_key so analyzers can pivot by
      // origin/destination geography without parsing metadata.
      scopeLaneKey: country ?? undefined,
      // Per-event id keeps the natural-key index unique even when many
      // rows share a country and second.
      scopeSku: eventId,
      scopeSupplierName: actor1 ?? undefined,
      value: eventCode,
      unit: "cameo_code",
      currency: "USD",
      observedAt,
      sourceUrl: upstreamUrl,
      confidence: 0.65,
      metadata: {
        globalEventId: eventId,
        sqlDate: cols[GDELT_EVENT_COLS.SQLDATE] ?? null,
        eventCode,
        actor1Name: actor1,
        actor1CountryCode: cols[GDELT_EVENT_COLS.Actor1CountryCode] || null,
        actor2Name: actor2,
        actor2CountryCode: cols[GDELT_EVENT_COLS.Actor2CountryCode] || null,
        goldsteinScale: parseOptionalFloat(cols[GDELT_EVENT_COLS.GoldsteinScale]),
        numMentions: parseOptionalFloat(cols[GDELT_EVENT_COLS.NumMentions]),
        avgTone: parseOptionalFloat(cols[GDELT_EVENT_COLS.AvgTone]),
        actionGeoFullName: cols[GDELT_EVENT_COLS.ActionGeo_FullName] || null,
        actionGeoCountryCode: country,
        actionGeoLat: parseOptionalFloat(cols[GDELT_EVENT_COLS.ActionGeo_Lat]),
        actionGeoLong: parseOptionalFloat(cols[GDELT_EVENT_COLS.ActionGeo_Long]),
      },
    });
  }
  return drafts;
}

function parseOptionalFloat(s: string | undefined): number | null {
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const gdeltMetadataSchema = z
  .object({
    globalEventId: z.string().min(1),
    eventCode: z.number(),
    actor1Name: z.string().nullable(),
    actor1CountryCode: z.string().nullable(),
    actor2Name: z.string().nullable(),
    actor2CountryCode: z.string().nullable(),
    goldsteinScale: z.number().nullable(),
    numMentions: z.number().nullable(),
    avgTone: z.number().nullable(),
    actionGeoFullName: z.string().nullable(),
    actionGeoCountryCode: z.string().nullable(),
    actionGeoLat: z.number().nullable(),
    actionGeoLong: z.number().nullable(),
  })
  .passthrough();

const gdeltSignalSchema = buildSignalDraftSchema(gdeltMetadataSchema);

export const gdeltEventsCollector: IntelligenceCollector<typeof gdeltSignalSchema> = {
  id: GDELT_EVENTS_COLLECTOR_ID,
  name: "GDELT 2.0 Geocoded Events",
  description:
    "Polls GDELT 2.0's lastupdate.txt for the most recent 15-minute events bundle, gunzips the events CSV, and emits geocoded event_geocoded MarketSignals (CAMEO event code, actors, location, tone). Hard-capped at 500 events per run.",
  posture: "public-api",
  sourceUrl: "https://www.gdeltproject.org/",
  defaultRateLimitRpm: 30,
  // Every 30 minutes is plenty given the 15-minute publishing cadence
  // and our 500-row cap per run.
  defaultScheduleCron: "*/30 * * * *",
  postureClass: "public_api",
  disclosureTier: "T2",
  jurisdiction: "GLOBAL",
  retentionDays: 365,
  tenantOptInDefault: false,
  signalSchema: gdeltSignalSchema,
  stableSignalKey(draft) {
    return defaultStableSignalKey(GDELT_EVENTS_COLLECTOR_ID, draft);
  },
  async collect({ signal } = { since: null }): Promise<MarketSignalDraft[]> {
    return (await this.collectWithRaw!({ since: null, signal })).drafts;
  },
  async collectWithRaw({ signal } = { since: null }): Promise<CollectWithRawResult> {
    const lastUpdateRes = await fetch(GDELT_LASTUPDATE_URL, { signal });
    if (!lastUpdateRes.ok) {
      throw new Error(`GDELT lastupdate HTTP ${lastUpdateRes.status}`);
    }
    const lastUpdateBody = await lastUpdateRes.text();
    const eventsUrl = parseLastUpdateForEventsUrl(lastUpdateBody);
    if (!eventsUrl) {
      throw new Error("GDELT lastupdate: no events URL found");
    }
    const eventsRes = await fetch(eventsUrl, { signal });
    if (!eventsRes.ok) {
      throw new Error(`GDELT events HTTP ${eventsRes.status} for ${eventsUrl}`);
    }
    const eventsBuffer = Buffer.from(await eventsRes.arrayBuffer());
    let csv: string;
    let wasGzipped = true;
    try {
      csv = gunzipSync(eventsBuffer).toString("utf8");
    } catch (err) {
      logger.warn(
        { collectorId: GDELT_EVENTS_COLLECTOR_ID, err },
        "GDELT events bundle was not gzipped — treating as plain text",
      );
      csv = eventsBuffer.toString("utf8");
      wasGzipped = false;
    }
    const drafts = parseGdeltEvents(csv, eventsUrl);
    const rawPayloads: RawPayload[] = [
      {
        name: "gdelt-lastupdate",
        contentType: "text/plain",
        body: lastUpdateBody,
        sourceUrl: GDELT_LASTUPDATE_URL,
      },
      {
        name: "gdelt-events-bundle",
        // Land the raw upstream bytes (gzipped) so replay reproduces
        // the byte-for-byte original. Decoding happens at parse time.
        contentType: wasGzipped ? "application/gzip" : "text/csv",
        body: eventsBuffer,
        sourceUrl: eventsUrl,
        metadata: { gzipped: wasGzipped, cap: GDELT_MAX_EVENTS_PER_RUN },
      },
    ];
    return { drafts, rawPayloads };
  },
};
