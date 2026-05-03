/**
 * Server-side helpers for the supplier-intelligence read path
 * (`GET /suppliers/:id/intelligence`).
 *
 * The Phase-2 public-API collectors (SEC EDGAR, Companies House,
 * GLEIF, OFAC/EU/UK/UN sanctions, OpenSanctions, ClimateTRACE,
 * GDELT, hazards) all land into one `market_signals` table and stamp
 * a deterministic `entityUid` into the row metadata so a supplier
 * page can join across sources without a separate dimension table.
 *
 * This module owns:
 *   - the canonical list of signal types the supplier risk timeline
 *     surfaces (`SUPPLIER_INTELLIGENCE_SIGNAL_TYPES`)
 *   - per-row "headline" / "detail" rendering — pulled out of the
 *     route so the rendering rules are unit-testable and don't bloat
 *     the route handler.
 *
 * The route itself does the org-scoped query, joins each signal
 * against the in-memory collector registry to attach the disclosure
 * `contract`, and shapes the response to match
 * `SupplierIntelligenceResponse` in the OpenAPI spec.
 */

import type { MarketSignalType } from "@workspace/db";

/**
 * Signal types surfaced on the supplier-intelligence response. This is
 * the subset of the Phase-2 collector signal types — the legacy commodity
 * / FX / freight / price-list / news flows are intentionally excluded
 * from the supplier risk timeline because they're modelled at the
 * material / lane / category level, not at the supplier-entity level.
 */
export const SUPPLIER_INTELLIGENCE_SIGNAL_TYPES = [
  "sanctions_match",
  "risk_screening_match",
  "corporate_filing",
  "entity_registry",
  "facility_emissions",
  "natural_hazard",
  "event_geocoded",
  "environmental_violation",
  "workplace_safety_incident",
] as const satisfies readonly MarketSignalType[];

export type SupplierIntelligenceSignalType =
  (typeof SUPPLIER_INTELLIGENCE_SIGNAL_TYPES)[number];

const SUPPLIER_INTELLIGENCE_SIGNAL_TYPES_SET: ReadonlySet<MarketSignalType> =
  new Set<MarketSignalType>(SUPPLIER_INTELLIGENCE_SIGNAL_TYPES);

export function isSupplierIntelligenceSignalType(
  t: MarketSignalType,
): t is SupplierIntelligenceSignalType {
  return SUPPLIER_INTELLIGENCE_SIGNAL_TYPES_SET.has(t);
}

/**
 * Inverse of `government-sanctions.SANCTIONS_LIST_CODES` — kept here
 * (rather than imported) because the renderer needs to translate the
 * persisted numeric `value` (1=OFAC, 2=EU, 3=UK, 4=UN) back into the
 * list label without taking a runtime dep on the collector module.
 */
const SANCTIONS_LIST_LABELS: Record<number, string> = {
  1: "OFAC SDN",
  2: "EU consolidated",
  3: "UK OFSI",
  4: "UN consolidated",
};

const EPA_STATUTE_LABELS: Record<number, string> = {
  1: "Clean Water Act",
  2: "Clean Air Act",
  3: "RCRA",
  4: "TSCA",
  5: "EPCRA",
  6: "Safe Drinking Water Act",
  7: "FIFRA",
};

const OSHA_SCOPE_LABELS: Record<number, string> = {
  1: "Comprehensive inspection",
  2: "Partial inspection",
  3: "Records inspection",
  4: "Referral inspection",
  5: "Complaint inspection",
  6: "Accident inspection",
  7: "Programmed inspection",
};

const HAZARD_SOURCE_LABELS: Record<number, string> = {
  1: "USGS earthquake",
  2: "NOAA NWS alert",
  3: "NASA EONET event",
  4: "GDACS alert",
};

const GLEIF_REGISTRATION_STATUS_LABELS: Record<number, string> = {
  1: "Issued",
  2: "Lapsed",
  3: "Merged",
  4: "Retired",
  5: "Duplicate",
  6: "Annulled",
  7: "Transferred",
  8: "Pending transfer",
  9: "Pending archival",
};

const COMPANIES_HOUSE_FILING_CATEGORY_LABELS: Record<number, string> = {
  1: "Accounts",
  2: "Confirmation statement",
  3: "Officers",
  4: "Capital",
  5: "Mortgage",
};

/**
 * What the route persists per row in `metadata` is collector-specific
 * — but the headline renderer wants a small, predictable contract.
 * Everything is `unknown` and we read defensively.
 */
type Meta = Record<string, unknown> | null | undefined;

function str(meta: Meta, ...keys: string[]): string | null {
  if (!meta) return null;
  for (const k of keys) {
    const v = meta[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

export interface SupplierIntelligenceRowInput {
  signalType: MarketSignalType;
  collectorId: string;
  collectorName: string;
  /** Numeric value persisted on the row (e.g. sanctions list code). */
  value: number;
  unit: string;
  scopeSupplierName: string | null;
  scopeCategoryCode: string | null;
  scopeSku: string | null;
  scopeLaneKey: string | null;
  metadata: Meta;
}

export interface RenderedHeadline {
  headline: string;
  detail: string | null;
}

/**
 * Pick a row title + sub-headline based on the signal type. The
 * mapping is intentionally explicit per type so a malformed metadata
 * blob never silently produces an empty or "[object Object]"-style
 * headline — the fallback always names the collector + signal type.
 */
export function renderSupplierIntelligenceHeadline(
  row: SupplierIntelligenceRowInput,
): RenderedHeadline {
  switch (row.signalType) {
    case "sanctions_match": {
      const list = SANCTIONS_LIST_LABELS[row.value] ?? row.unit;
      const program = str(row.metadata, "program");
      const country = str(row.metadata, "country");
      return {
        headline: `Sanctions match — ${list}`,
        detail: [program, country].filter(Boolean).join(" · ") || null,
      };
    }
    case "risk_screening_match": {
      const datasets = (() => {
        if (!row.metadata) return null;
        const d = (row.metadata as { datasets?: unknown }).datasets;
        if (!Array.isArray(d) || d.length === 0) return null;
        return d.filter((x) => typeof x === "string").join(", ") || null;
      })();
      const topics = (() => {
        if (!row.metadata) return null;
        const t = (row.metadata as { topics?: unknown }).topics;
        if (!Array.isArray(t) || t.length === 0) return null;
        return t.filter((x) => typeof x === "string").join(", ") || null;
      })();
      return {
        headline: "Risk-screening match (OpenSanctions)",
        detail:
          [datasets, topics].filter(Boolean).join(" — ") ||
          str(row.metadata, "name") ||
          null,
      };
    }
    case "corporate_filing": {
      const isCompaniesHouse = row.collectorId === "companies-house";
      if (isCompaniesHouse) {
        const category =
          COMPANIES_HOUSE_FILING_CATEGORY_LABELS[row.value] ?? "Filing";
        const description = str(row.metadata, "description", "subcategory");
        return {
          headline: `Companies House filing — ${category}`,
          detail: description,
        };
      }
      // SEC EDGAR (or any future SEC-shaped corporate_filing collector).
      const form = str(row.metadata, "formCode", "formType") ?? row.scopeSku;
      const accession = str(row.metadata, "accessionNumber");
      return {
        headline: `SEC filing${form ? ` — ${form}` : ""}`,
        detail: accession,
      };
    }
    case "entity_registry": {
      const status = GLEIF_REGISTRATION_STATUS_LABELS[row.value] ?? "Update";
      const lei = row.scopeSku ?? str(row.metadata, "lei");
      return {
        headline: `LEI registry — ${status}`,
        detail: lei,
      };
    }
    case "facility_emissions": {
      const sector = row.scopeCategoryCode;
      const tonnes = Number.isFinite(row.value)
        ? `${Math.round(row.value).toLocaleString("en-US")} t CO2e`
        : null;
      const year = str(row.metadata, "year");
      return {
        headline: `Facility emissions${sector ? ` — ${sector}` : ""}`,
        detail: [tonnes, year].filter(Boolean).join(" · ") || null,
      };
    }
    case "natural_hazard": {
      const source = HAZARD_SOURCE_LABELS[row.value] ?? "Hazard";
      const place = str(row.metadata, "place", "title", "headline");
      return { headline: source, detail: place };
    }
    case "environmental_violation": {
      const statute = EPA_STATUTE_LABELS[row.value] ?? "EPA enforcement";
      const facility = str(row.metadata, "facilityName");
      const state = str(row.metadata, "facilityState");
      const detail =
        [facility, state].filter(Boolean).join(" · ") ||
        str(row.metadata, "caseName") ||
        null;
      return {
        headline: `EPA enforcement — ${statute}`,
        detail,
      };
    }
    case "workplace_safety_incident": {
      const scope = OSHA_SCOPE_LABELS[row.value] ?? "OSHA inspection";
      const violations = (() => {
        if (!row.metadata) return null;
        const v = (row.metadata as { totalViolations?: unknown })
          .totalViolations;
        return typeof v === "number" && v > 0 ? `${v} violation(s)` : null;
      })();
      const state = str(row.metadata, "siteState");
      const detail =
        [violations, state].filter(Boolean).join(" · ") ||
        str(row.metadata, "establishmentName") ||
        null;
      return { headline: scope, detail };
    }
    case "event_geocoded": {
      const code = str(row.metadata, "eventCode", "eventBaseCode");
      const country = row.scopeLaneKey ?? str(row.metadata, "country");
      return {
        headline: `Geocoded event${code ? ` — ${code}` : ""}`,
        detail: country,
      };
    }
    default: {
      // Defensive: a future signal type added to the union without a
      // matching renderer falls through to a name-only headline so the
      // UI still has something to show instead of the empty string.
      return {
        headline: `${row.collectorName} signal`,
        detail: null,
      };
    }
  }
}
