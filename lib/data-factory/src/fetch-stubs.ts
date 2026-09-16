/**
 * Layer A fetch stubs.
 *
 * Day 0 does not live-fetch. Wired sources point at existing collectors.
 * Stubs return empty observations with the cited URL. Paid-license
 * sources refuse to fetch — no scrape, no invented index values.
 */

import {
  DATA_FACTORY_SOURCES,
  getDataFactorySource,
  type DataFactorySource,
} from "./catalog";

export type LayerAFetchResult =
  | {
      status: "wired_existing_collector";
      sourceId: string;
      collectorId: string;
      sourceUrl: string;
      feedUrl: string;
      observations: [];
      note: string;
    }
  | {
      status: "stub";
      sourceId: string;
      sourceUrl: string;
      feedUrl: string;
      observations: [];
      note: string;
    }
  | {
      status: "blocked_pending_license";
      sourceId: string;
      sourceUrl: string;
      feedUrl: string;
      observations: [];
      note: string;
    }
  | {
      status: "unknown_source";
      sourceId: string;
      observations: [];
      note: string;
    };

export function fetchLayerASource(sourceId: string): LayerAFetchResult {
  const source = getDataFactorySource(sourceId);
  if (!source) {
    return {
      status: "unknown_source",
      sourceId,
      observations: [],
      note: "Not in the Day 0 Layer A catalog.",
    };
  }
  return fetchKnownSource(source);
}

function fetchKnownSource(source: DataFactorySource): LayerAFetchResult {
  if (source.fetchStatus === "blocked_pending_license") {
    return {
      status: "blocked_pending_license",
      sourceId: source.id,
      sourceUrl: source.sourceUrl,
      feedUrl: source.feedUrl,
      observations: [],
      note: `Paid/commercial license required. Human approval needed before any fetch. ${source.licenseNote}`,
    };
  }
  if (source.fetchStatus === "wired_existing_collector") {
    return {
      status: "wired_existing_collector",
      sourceId: source.id,
      collectorId: source.existingCollectorId ?? "unknown",
      sourceUrl: source.sourceUrl,
      feedUrl: source.feedUrl,
      observations: [],
      note:
        "Live fetch stays on the existing IntelligenceCollector runtime. This stub does not dump market_signals (avoids mixing tenant-scoped rows).",
    };
  }
  return {
    status: "stub",
    sourceId: source.id,
    sourceUrl: source.sourceUrl,
    feedUrl: source.feedUrl,
    observations: [],
    note: `Day 0 stub — no live HTTP. Cite ${source.sourceUrl} when implementing the collector.`,
  };
}

export function fetchAllLayerASources(): LayerAFetchResult[] {
  return DATA_FACTORY_SOURCES.map((s) => fetchKnownSource(s));
}
