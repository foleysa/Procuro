/**
 * SAM.gov federal entity-registration & exclusions collector.
 *
 * SAM.gov is the master record of every entity registered to do
 * business with the US federal government, plus the official US
 * exclusions list (parties debarred or otherwise barred from federal
 * contracting). Both surfaces are critical compliance signals on a
 * supplier-360 page.
 *
 * Two endpoints, one per watched supplier name:
 *   - Entity registration:
 *       GET https://api.sam.gov/entity-information/v3/entities
 *           ?api_key=...&legalBusinessName=NAME
 *     → emits `entity_registry` (value = registration status code)
 *   - Exclusions:
 *       GET https://api.sam.gov/exclusions/v1/api/exclusions
 *           ?api_key=...&exclusionName=NAME
 *     → emits `sanctions_match` with list code 5 ("SAM.gov exclusion")
 *       so the existing alert-fanout treats it the same way it treats
 *       OFAC / EU / UK / UN sanctions hits — critical severity, fan-out
 *       to every tenant whose suppliers match.
 *
 * Key handling:
 *   The SAM_GOV_API_KEY env var is read at collect-time. When missing,
 *   we log a warning and return zero drafts (and no raw payloads) — the
 *   collector run still succeeds, the registry row is still seeded, and
 *   the System / Collector workbench page surfaces it as "approved but
 *   producing no signals" until an operator wires up the key. This
 *   mirrors how `companies-house` and other key-gated public-API
 *   collectors degrade.
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
import { loadWatchedSupplierNames } from "./_watched-suppliers";
import { resolveDraftEntities } from "./_entity-resolver";

export const SAM_GOV_COLLECTOR_ID = "sam-gov";

const SAM_ENTITIES_URL =
  "https://api.sam.gov/entity-information/v3/entities";
const SAM_EXCLUSIONS_URL =
  "https://api.sam.gov/exclusions/v1/api/exclusions";

/**
 * SAM list code reserved on the `sanctions_match` `value` column.
 * 1 = OFAC, 2 = EU, 3 = UK, 4 = UN (see government-sanctions.ts);
 * 5 = SAM.gov exclusion. The `supplier-intelligence.ts` renderer maps
 * this back to a human label.
 */
export const SAM_EXCLUSION_LIST_CODE = 5;

/**
 * Numeric code persisted on `entity_registry` rows from this collector.
 * 1 = Active, 2 = Expired, 3 = Inactive / Submitted, 4 = Other. Matches
 * the GLEIF-style numeric-code pattern the supplier-intelligence
 * renderer already understands.
 */
export const SAM_REGISTRATION_STATUS_CODES = {
  Active: 1,
  Expired: 2,
  Inactive: 3,
  Other: 4,
} as const;
export type SamRegistrationStatusCode =
  (typeof SAM_REGISTRATION_STATUS_CODES)[keyof typeof SAM_REGISTRATION_STATUS_CODES];

const SAM_MAX_SUPPLIERS_PER_RUN = 50;
const SAM_MAX_SUPPLIERS_PER_BACKFILL = 250;

/**
 * Stable sentinel `observedAt` used when the upstream record is missing
 * its registration / activation date. Wall-clock fallback (`new Date()`)
 * would break re-run idempotency because the natural-key dedupe index
 * includes `observed_at` — two runs of the same data would land two
 * rows. The sentinel is deterministic per (supplier, sku) so re-runs
 * collapse cleanly under `ON CONFLICT DO NOTHING`.
 */
export const SAM_UNKNOWN_DATE_SENTINEL = new Date("1970-01-01T00:00:00.000Z");

interface SamEntityRecord {
  ueiSAM: string | null;
  legalBusinessName: string;
  registrationStatus: string | null;
  registrationDate: Date | null;
  expirationDate: Date | null;
  countryCode: string | null;
}

interface SamExclusionRecord {
  classification: string | null;
  legalBusinessName: string;
  exclusionType: string | null;
  excludingAgencyCode: string | null;
  exclusionProgram: string | null;
  activationDate: Date | null;
  terminationDate: Date | null;
  exclusionId: string;
  countryCode: string | null;
  ueiSAM: string | null;
}

/** Map a SAM `registrationStatus` string to our numeric code. */
function registrationStatusCode(status: string | null): SamRegistrationStatusCode {
  const s = (status ?? "").toLowerCase();
  if (s === "active") return SAM_REGISTRATION_STATUS_CODES.Active;
  if (s === "expired") return SAM_REGISTRATION_STATUS_CODES.Expired;
  if (s === "inactive" || s === "submitted") {
    return SAM_REGISTRATION_STATUS_CODES.Inactive;
  }
  return SAM_REGISTRATION_STATUS_CODES.Other;
}

/** Defensive parse: the SAM `entityData[].entityRegistration` envelope. */
export function parseSamEntities(json: unknown): SamEntityRecord[] {
  if (!json || typeof json !== "object") return [];
  const data = (json as { entityData?: unknown }).entityData;
  if (!Array.isArray(data)) return [];
  const out: SamEntityRecord[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const reg = (row as { entityRegistration?: unknown }).entityRegistration;
    if (!reg || typeof reg !== "object") continue;
    const r = reg as Record<string, unknown>;
    const legalBusinessName =
      typeof r["legalBusinessName"] === "string"
        ? (r["legalBusinessName"] as string)
        : null;
    if (!legalBusinessName) continue;
    const core =
      ((row as { coreData?: { entityInformation?: unknown } }).coreData
        ?.entityInformation as Record<string, unknown> | undefined) ?? null;
    const countryCode =
      core && typeof core["countryCode"] === "string"
        ? (core["countryCode"] as string)
        : null;
    out.push({
      ueiSAM:
        typeof r["ueiSAM"] === "string" ? (r["ueiSAM"] as string) : null,
      legalBusinessName,
      registrationStatus:
        typeof r["registrationStatus"] === "string"
          ? (r["registrationStatus"] as string)
          : null,
      registrationDate: parseDate(r["registrationDate"]),
      expirationDate: parseDate(r["registrationExpirationDate"]),
      countryCode,
    });
  }
  return out;
}

/** Defensive parse: the SAM `excludedEntity[]` envelope. */
export function parseSamExclusions(json: unknown): SamExclusionRecord[] {
  if (!json || typeof json !== "object") return [];
  const data =
    (json as { excludedEntity?: unknown; excludedEntities?: unknown })
      .excludedEntity ??
    (json as { excludedEntities?: unknown }).excludedEntities;
  if (!Array.isArray(data)) return [];
  const out: SamExclusionRecord[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const exc =
      (r["exclusionDetails"] as Record<string, unknown> | undefined) ?? r;
    const exclusionId =
      (typeof exc["exclusionProgram"] === "string"
        ? (exc["exclusionProgram"] as string)
        : "") +
      ":" +
      (typeof r["activationDate"] === "string"
        ? (r["activationDate"] as string)
        : "");
    const legalBusinessName =
      (typeof r["exclusionName"] === "string"
        ? (r["exclusionName"] as string)
        : null) ??
      (typeof r["name"] === "string" ? (r["name"] as string) : null) ??
      (typeof r["legalBusinessName"] === "string"
        ? (r["legalBusinessName"] as string)
        : null);
    if (!legalBusinessName) continue;
    const idCandidate =
      typeof r["recordId"] === "string"
        ? (r["recordId"] as string)
        : typeof r["uniqueId"] === "string"
          ? (r["uniqueId"] as string)
          : exclusionId;
    out.push({
      classification:
        typeof r["classificationType"] === "string"
          ? (r["classificationType"] as string)
          : null,
      legalBusinessName,
      exclusionType:
        typeof exc["exclusionType"] === "string"
          ? (exc["exclusionType"] as string)
          : null,
      excludingAgencyCode:
        typeof exc["excludingAgencyCode"] === "string"
          ? (exc["excludingAgencyCode"] as string)
          : null,
      exclusionProgram:
        typeof exc["exclusionProgram"] === "string"
          ? (exc["exclusionProgram"] as string)
          : null,
      activationDate: parseDate(r["activationDate"]),
      terminationDate: parseDate(r["terminationDate"]),
      exclusionId: idCandidate,
      countryCode:
        typeof r["countryCode"] === "string"
          ? (r["countryCode"] as string)
          : null,
      ueiSAM:
        typeof r["ueiSAM"] === "string" ? (r["ueiSAM"] as string) : null,
    });
  }
  return out;
}

function parseDate(raw: unknown): Date | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

const samMetadataSchema = z
  .object({
    source: z.enum(["sam_entity", "sam_exclusion"]),
  })
  .passthrough();

const samSignalSchema = buildSignalDraftSchema(samMetadataSchema);

async function fetchSamJson(
  base: string,
  query: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ json: unknown; raw: string }> {
  const url = new URL(base);
  for (const [k, v] of Object.entries(query)) {
    url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Procuro Compliance Platform",
      accept: "application/json",
    },
    signal,
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${base}`);
  }
  const raw = await res.text();
  return { json: JSON.parse(raw), raw };
}

export const samGovCollector: IntelligenceCollector<typeof samSignalSchema> = {
  id: SAM_GOV_COLLECTOR_ID,
  name: "SAM.gov entity registrations & exclusions",
  description:
    "Polls SAM.gov per watched supplier name. Emits one entity_registry MarketSignal per registered entity (value = registration status code: 1=Active, 2=Expired, 3=Inactive, 4=Other) and one sanctions_match per exclusion (value = 5, the SAM.gov list code). Reads SAM_GOV_API_KEY at collect-time and degrades to zero drafts with a warning when the key is missing.",
  posture: "public-api",
  sourceUrl: "https://api.sam.gov/",
  defaultRateLimitRpm: 20,
  // SAM updates daily; one early-morning sweep is plenty.
  defaultScheduleCron: "40 5 * * *",
  postureClass: "public_api",
  disclosureTier: "T1",
  jurisdiction: "US",
  retentionDays: 730,
  tenantOptInDefault: true,
  signalSchema: samSignalSchema,
  stableSignalKey(draft) {
    return defaultStableSignalKey(SAM_GOV_COLLECTOR_ID, draft);
  },
  async collect({ signal, mode } = { since: null }): Promise<MarketSignalDraft[]> {
    return (
      await this.collectWithRaw!({ since: null, signal, mode: mode ?? "latest" })
    ).drafts;
  },
  async collectWithRaw({ signal, mode } = { since: null }): Promise<CollectWithRawResult> {
    const apiKey = process.env["SAM_GOV_API_KEY"];
    if (!apiKey || apiKey.trim() === "") {
      // Graceful degradation: a missing key is a config gap, not a
      // collector bug. We emit zero signals so the run row records
      // success and the workbench surfaces "no signals from this
      // source" rather than a red `fetch_failed`. Operators add the
      // SAM_GOV_API_KEY env var to start collecting.
      logger.warn(
        { collectorId: SAM_GOV_COLLECTOR_ID },
        "SAM_GOV_API_KEY not set; skipping run (zero drafts emitted)",
      );
      return { drafts: [], rawPayloads: [] };
    }

    const isBackfill = mode === "backfill";
    const supplierCap = isBackfill
      ? SAM_MAX_SUPPLIERS_PER_BACKFILL
      : SAM_MAX_SUPPLIERS_PER_RUN;

    const watched = await loadWatchedSupplierNames({ limit: supplierCap });
    if (watched.length === 0) {
      return { drafts: [], rawPayloads: [] };
    }

    const drafts: MarketSignalDraft[] = [];
    const rawPayloads: RawPayload[] = [];
    let entityFailures = 0;
    let exclusionFailures = 0;

    // Collect raw records first, resolve UIDs in one parallel pass at
    // the end (matches the USAspending and GLEIF patterns).
    const entityRecords: SamEntityRecord[] = [];
    const exclusionRecords: SamExclusionRecord[] = [];

    for (const w of watched) {
      // Entity registration lookup.
      try {
        const { json, raw } = await fetchSamJson(
          SAM_ENTITIES_URL,
          { api_key: apiKey, legalBusinessName: w.name, samRegistered: "Yes" },
          signal,
        );
        const records = parseSamEntities(json);
        rawPayloads.push({
          name: `sam-entity-${slug(w.name)}`,
          contentType: "application/json",
          body: raw,
          sourceUrl: SAM_ENTITIES_URL,
          metadata: { legalBusinessName: w.name, records: records.length },
        });
        for (const r of records) entityRecords.push(r);
      } catch (err) {
        entityFailures++;
        logger.warn(
          {
            collectorId: SAM_GOV_COLLECTOR_ID,
            supplier: w.name,
            err: (err as Error).message,
          },
          "SAM entity lookup failed for supplier; continuing",
        );
      }

      // Exclusions lookup.
      try {
        const { json, raw } = await fetchSamJson(
          SAM_EXCLUSIONS_URL,
          { api_key: apiKey, exclusionName: w.name },
          signal,
        );
        const records = parseSamExclusions(json);
        rawPayloads.push({
          name: `sam-exclusion-${slug(w.name)}`,
          contentType: "application/json",
          body: raw,
          sourceUrl: SAM_EXCLUSIONS_URL,
          metadata: { exclusionName: w.name, records: records.length },
        });
        for (const r of records) exclusionRecords.push(r);
      } catch (err) {
        exclusionFailures++;
        logger.warn(
          {
            collectorId: SAM_GOV_COLLECTOR_ID,
            supplier: w.name,
            err: (err as Error).message,
          },
          "SAM exclusion lookup failed for supplier; continuing",
        );
      }
    }

    const entityUids = await resolveDraftEntities(
      entityRecords.map((r) => ({
        collectorId: SAM_GOV_COLLECTOR_ID,
        name: r.legalBusinessName,
        country: r.countryCode ?? "US",
        ...(r.ueiSAM ? { identifiers: { uei: r.ueiSAM } } : {}),
      })),
    );
    for (let i = 0; i < entityRecords.length; i++) {
      drafts.push(entityToDraft(entityRecords[i]!, entityUids[i] ?? null));
    }

    const exclusionUids = await resolveDraftEntities(
      exclusionRecords.map((r) => ({
        collectorId: SAM_GOV_COLLECTOR_ID,
        name: r.legalBusinessName,
        country: r.countryCode ?? "US",
        ...(r.ueiSAM ? { identifiers: { uei: r.ueiSAM } } : {}),
      })),
    );
    for (let i = 0; i < exclusionRecords.length; i++) {
      drafts.push(exclusionToDraft(exclusionRecords[i]!, exclusionUids[i] ?? null));
    }

    if (
      drafts.length === 0 &&
      entityFailures === watched.length &&
      exclusionFailures === watched.length &&
      watched.length > 0
    ) {
      throw new Error(
        `sam-gov: every supplier lookup failed (${entityFailures} entity, ${exclusionFailures} exclusion)`,
      );
    }
    return { drafts, rawPayloads };
  },
};

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);
}

/**
 * Build an `entity_registry` draft from a parsed SAM entity record.
 * Exported so tests (and any future replay tooling) can drive the same
 * deterministic draft shape without re-running the HTTP layer.
 *
 * Idempotency contract: `observedAt` falls back to a stable sentinel
 * (`SAM_UNKNOWN_DATE_SENTINEL`) when SAM's payload doesn't carry a
 * `registrationDate`, so re-runs collapse via the natural-key dedupe.
 */
export function entityToDraft(
  r: SamEntityRecord,
  entityUid: string | null,
): MarketSignalDraft {
  const code = registrationStatusCode(r.registrationStatus);
  return {
    signalType: "entity_registry",
    scopeSupplierName: r.legalBusinessName,
    scopeSku: r.ueiSAM ?? r.legalBusinessName,
    ...(r.countryCode ? { scopeRegionCode: r.countryCode } : {}),
    value: code,
    unit: "sam_registration_status",
    currency: "USD",
    observedAt: r.registrationDate ?? SAM_UNKNOWN_DATE_SENTINEL,
    sourceUrl: SAM_ENTITIES_URL,
    confidence: 0.95,
    ...(entityUid ? { entityUid } : {}),
    metadata: {
      source: "sam_entity",
      ueiSAM: r.ueiSAM,
      registrationStatus: r.registrationStatus,
      registrationDate: r.registrationDate?.toISOString() ?? null,
      expirationDate: r.expirationDate?.toISOString() ?? null,
      country: r.countryCode,
    },
  };
}

/**
 * Build a `sanctions_match` draft (list code 5 = SAM.gov exclusion)
 * from a parsed SAM exclusion record. The collector-fanout module
 * routes every `sanctions_match` draft through critical-severity
 * tenant alerts — see `lib/alerts/collector-fanout.ts`.
 */
export function exclusionToDraft(
  r: SamExclusionRecord,
  entityUid: string | null,
): MarketSignalDraft {
  return {
    signalType: "sanctions_match",
    scopeSupplierName: r.legalBusinessName,
    scopeSku: `SAM:${r.exclusionId}`,
    ...(r.countryCode ? { scopeLaneKey: r.countryCode } : {}),
    value: SAM_EXCLUSION_LIST_CODE,
    unit: "list_code",
    currency: "USD",
    observedAt: r.activationDate ?? SAM_UNKNOWN_DATE_SENTINEL,
    sourceUrl: SAM_EXCLUSIONS_URL,
    confidence: 0.99,
    ...(entityUid ? { entityUid } : {}),
    metadata: {
      source: "sam_exclusion",
      listName: "SAM",
      listCode: SAM_EXCLUSION_LIST_CODE,
      classification: r.classification,
      exclusionType: r.exclusionType,
      excludingAgencyCode: r.excludingAgencyCode,
      program: r.exclusionProgram,
      activationDate: r.activationDate?.toISOString() ?? null,
      terminationDate: r.terminationDate?.toISOString() ?? null,
      exclusionId: r.exclusionId,
      country: r.countryCode,
      ueiSAM: r.ueiSAM,
    },
  };
}
