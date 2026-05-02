import { describe, expect, it } from "vitest";
import type { IntelligenceRiskHeatmapCell } from "@workspace/api-client-react";
import { aggregateCellsByCountry } from "../src/components/risk-heatmap-map";

/**
 * The Risk Heatmap map paints each country with a *single* color even
 * though the API returns one cell per (country, dimension). This test
 * pins the aggregation rule so a regression doesn't quietly turn the
 * choropleth into "the most recently iterated dimension wins" — which
 * would hide hot zones.
 */

function cell(
  country: string,
  dimension: string,
  band: IntelligenceRiskHeatmapCell["band"],
  score: number,
  signalCount: number,
): IntelligenceRiskHeatmapCell {
  return {
    country,
    dimension: dimension as IntelligenceRiskHeatmapCell["dimension"],
    band,
    score,
    signalCount,
    topContributors: [],
  };
}

describe("aggregateCellsByCountry", () => {
  it("collapses one cell per country, keyed uppercase", () => {
    const out = aggregateCellsByCountry([
      cell("us", "geopolitical", "low", 12, 3),
      cell("CN", "supply", "high", 78, 9),
    ]);
    expect(out.size).toBe(2);
    expect(out.get("US")?.band).toBe("low");
    expect(out.get("CN")?.band).toBe("high");
    // ISO-2 normalization — "us" became "US".
    expect(out.has("us")).toBe(false);
  });

  it("picks the worst band when a country has multiple dimensions", () => {
    const out = aggregateCellsByCountry([
      cell("DE", "fx", "low", 8, 2),
      cell("DE", "supply", "elevated", 55, 4),
      cell("DE", "geopolitical", "moderate", 32, 3),
    ]);
    expect(out.get("DE")?.band).toBe("elevated");
  });

  it("'high' wins over 'elevated' / 'moderate' / 'low'", () => {
    const out = aggregateCellsByCountry([
      cell("RU", "supply", "moderate", 30, 1),
      cell("RU", "geopolitical", "high", 88, 6),
      cell("RU", "fx", "elevated", 50, 2),
    ]);
    const r = out.get("RU");
    expect(r?.band).toBe("high");
    // Score is the *max* across dimensions so the legend matches what
    // the map shows.
    expect(r?.score).toBe(88);
    // Signal counts add together so the tooltip shows total volume.
    expect(r?.signalCount).toBe(9);
  });

  it("sorts topDimensions by score descending so tooltips lead with the worst", () => {
    const out = aggregateCellsByCountry([
      cell("CN", "fx", "low", 10, 1),
      cell("CN", "supply", "high", 80, 3),
      cell("CN", "geopolitical", "moderate", 40, 2),
    ]);
    const dims = out.get("CN")?.topDimensions ?? [];
    expect(dims.map((d) => d.dimension)).toEqual([
      "supply",
      "geopolitical",
      "fx",
    ]);
  });

  it("returns an empty map when no cells are provided", () => {
    expect(aggregateCellsByCountry([]).size).toBe(0);
  });

  it("filters to a single dimension when one is selected", () => {
    // The map's dimension toggle re-aggregates with a specific dim so
    // each country is colored by *that* dimension's signal only.
    const out = aggregateCellsByCountry(
      [
        cell("DE", "fx", "low", 8, 2),
        cell("DE", "supply", "elevated", 55, 4),
        cell("CN", "supply", "high", 80, 6),
        cell("CN", "fx", "moderate", 30, 1),
      ],
      "supply",
    );
    expect(out.size).toBe(2);
    expect(out.get("DE")?.band).toBe("elevated");
    expect(out.get("DE")?.score).toBe(55);
    expect(out.get("CN")?.band).toBe("high");
    expect(out.get("CN")?.score).toBe(80);
  });

  it("drops countries with no signal in the selected dimension", () => {
    // Per task: "countries with no signal in that dimension stay
    // unshaded" — i.e. they must not appear in the aggregation map
    // so the choropleth leaves them transparent.
    const out = aggregateCellsByCountry(
      [
        cell("US", "geopolitical", "high", 90, 4),
        cell("DE", "fx", "moderate", 30, 2),
      ],
      "supply",
    );
    expect(out.size).toBe(0);
  });

  it("treats 'any' as no filter and preserves worst-band-wins", () => {
    const out = aggregateCellsByCountry(
      [
        cell("RU", "supply", "moderate", 30, 1),
        cell("RU", "geopolitical", "high", 88, 6),
      ],
      "any",
    );
    expect(out.get("RU")?.band).toBe("high");
  });
});
