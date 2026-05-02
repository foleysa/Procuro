import { useEffect, useRef, useState } from "react";
import type {
  IntelligenceRiskHeatmapCell,
  IntelligenceRiskHeatmapResponseSitesItem,
} from "@workspace/api-client-react";
import { m49ToIso2 } from "@/lib/country-codes";

/**
 * Live world-map view of the Risk Heatmap.
 *
 * Renders a Maplibre map with free Carto raster tiles and a country
 * choropleth fill driven by the per-country `cells` payload from
 * `/api/intelligence/risk/heatmap`. For each country we color by the
 * single highest-band dimension so regional concentrations and hot
 * zones jump out at a glance — drilling into the dimension breakdown
 * still happens via the existing grid table or by clicking through.
 *
 * Loading is best-effort: maplibre, the topojson client, and the
 * world-atlas geometry are all lazy-imported so the rest of the
 * Fusion Center stays snappy. If anything fails (network, WebGL
 * unavailable, tile timeout on first render) we surface that to the
 * parent via `onMapUnavailable` so it can fall back to the grid view.
 */

export type CountryRisk = {
  country: string;
  band: "low" | "moderate" | "elevated" | "high";
  score: number;
  signalCount: number;
  topDimensions: Array<{ dimension: string; score: number }>;
};

export function aggregateCellsByCountry(
  cells: IntelligenceRiskHeatmapCell[],
  dimension?: string,
): Map<string, CountryRisk> {
  const out = new Map<string, CountryRisk>();
  const bandRank: Record<CountryRisk["band"], number> = {
    low: 0,
    moderate: 1,
    elevated: 2,
    high: 3,
  };
  const filter = dimension && dimension !== "any" ? dimension : null;
  for (const c of cells) {
    if (filter && c.dimension !== filter) continue;
    const key = c.country.toUpperCase();
    const prev = out.get(key);
    const next: CountryRisk = prev
      ? {
          country: key,
          band: bandRank[c.band] > bandRank[prev.band] ? c.band : prev.band,
          score: Math.max(prev.score, c.score),
          signalCount: prev.signalCount + c.signalCount,
          topDimensions: prev.topDimensions.concat([
            { dimension: c.dimension, score: c.score },
          ]),
        }
      : {
          country: key,
          band: c.band,
          score: c.score,
          signalCount: c.signalCount,
          topDimensions: [{ dimension: c.dimension, score: c.score }],
        };
    next.topDimensions.sort((a, b) => b.score - a.score);
    out.set(key, next);
  }
  return out;
}

const BAND_FILL: Record<CountryRisk["band"], string> = {
  low: "#10b981",
  moderate: "#eab308",
  elevated: "#f59e0b",
  high: "#ef4444",
};

type Props = {
  cells: IntelligenceRiskHeatmapCell[];
  sites?: IntelligenceRiskHeatmapResponseSitesItem[];
  onCountryClick: (countryIso2: string) => void;
  onSiteClick?: (siteId: string) => void;
  onMapUnavailable: (reason: string) => void;
  selectedDimension?: string;
};

type SiteHover = {
  siteId: string;
  label: string;
  country: string;
  band: CountryRisk["band"];
  score: number;
  signalCount: number;
  recentSpend: number | null;
  x: number;
  y: number;
};

export function RiskHeatmapMap({
  cells,
  sites = [],
  onCountryClick,
  onSiteClick,
  onMapUnavailable,
  selectedDimension,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // We keep the map in a ref so React re-renders (driven by `cells`
  // changes) don't re-create it. `any` here is deliberate — the
  // maplibre-gl Map type only exists once the dynamic import resolves.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapRef = useRef<any>(null);
  const [loaded, setLoaded] = useState(false);
  const [hover, setHover] = useState<{
    iso2: string;
    name: string;
    risk: CountryRisk | null;
    x: number;
    y: number;
  } | null>(null);
  const [siteHover, setSiteHover] = useState<SiteHover | null>(null);
  // Stash the latest callback in a ref so the (one-time) map init can
  // call the freshest function without re-binding handlers per render.
  const onSiteClickRef = useRef(onSiteClick);
  useEffect(() => {
    onSiteClickRef.current = onSiteClick;
  }, [onSiteClick]);

  // ---- Initialize map exactly once ----
  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;

    (async () => {
      try {
        const [{ default: maplibregl }, topojson, atlas] = await Promise.all([
          import("maplibre-gl"),
          import("topojson-client"),
          // world-atlas ships a pure-data JSON; vite handles the
          // import as a parsed object thanks to resolveJsonModule.
          import("world-atlas/countries-110m.json"),
        ]);
        await import("maplibre-gl/dist/maplibre-gl.css");

        if (cancelled) return;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const topology = (atlas as any).default ?? atlas;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const geo = topojson.feature(
          topology,
          topology.objects.countries,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ) as any;

        // Stamp ISO-2 + a stable feature id so the choropleth
        // expression and click handlers can key off ISO-2 directly.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const features = (geo.features as any[])
          .map((f, i) => {
            const iso2 = m49ToIso2(String(f.id ?? ""));
            if (!iso2) return null;
            return {
              ...f,
              id: i + 1,
              properties: {
                ...f.properties,
                iso2,
                name: f.properties?.name ?? iso2,
              },
            };
          })
          .filter(Boolean);

        const map = new maplibregl.Map({
          container,
          style: {
            version: 8,
            sources: {
              "carto-light": {
                type: "raster",
                tiles: [
                  "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
                  "https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
                  "https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
                  "https://d.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
                ],
                tileSize: 256,
                attribution:
                  '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
              },
            },
            layers: [
              {
                id: "carto-light",
                type: "raster",
                source: "carto-light",
              },
            ],
          },
          center: [10, 25],
          zoom: 1.4,
          minZoom: 1,
          maxZoom: 6,
          attributionControl: { compact: true },
          // Disable map rotation: this is a flat overview, pitch/bearing
          // would just confuse users.
          dragRotate: false,
          pitchWithRotate: false,
        });
        mapRef.current = map;

        // Surface WebGL/style errors as a fallback signal. Tile-level
        // 404s also bubble through here; we only fall back if the
        // map itself fails before `load`.
        let isReady = false;
        map.on("error", (e: { error?: Error }) => {
          if (!isReady) {
            onMapUnavailable(
              e?.error?.message ?? "Map failed to initialize",
            );
          }
        });

        map.on("load", () => {
          if (cancelled) return;
          map.addSource("countries", {
            type: "geojson",
            data: { type: "FeatureCollection", features },
            promoteId: "iso2",
          });

          map.addLayer({
            id: "countries-fill",
            type: "fill",
            source: "countries",
            paint: {
              // Per-country band → fill color, expressed via
              // feature-state set in the second effect. Default fill
              // is fully transparent so the basemap shows through
              // for countries with no data.
              "fill-color": [
                "case",
                ["==", ["feature-state", "band"], "high"],
                BAND_FILL.high,
                ["==", ["feature-state", "band"], "elevated"],
                BAND_FILL.elevated,
                ["==", ["feature-state", "band"], "moderate"],
                BAND_FILL.moderate,
                ["==", ["feature-state", "band"], "low"],
                BAND_FILL.low,
                "#000000",
              ],
              "fill-opacity": [
                "case",
                ["!=", ["feature-state", "band"], null],
                0.55,
                0,
              ],
            },
          });
          map.addLayer({
            id: "countries-outline",
            type: "line",
            source: "countries",
            paint: {
              "line-color": "#475569",
              "line-width": [
                "case",
                ["boolean", ["feature-state", "hover"], false],
                1.4,
                0.4,
              ],
              "line-opacity": 0.6,
            },
          });

          // Click → propagate ISO-2 up to the page so it can swap
          // the tab to Signal Browser pre-filtered.
          map.on("click", "countries-fill", (e: {
            features?: Array<{ properties?: { iso2?: string } }>;
            originalEvent?: MouseEvent;
          }) => {
            // Bail if the sites-circle click handler already routed
            // this click to Entity 360 — we don't want to also flip
            // the tab to Signal Browser. We stash a marker on the
            // shared DOM event so layer handlers can coordinate.
            if (
              (e.originalEvent as unknown as { _siteHandled?: boolean })
                ?._siteHandled
            )
              return;
            const f = e.features?.[0];
            const iso2 = f?.properties?.iso2;
            if (iso2) onCountryClick(iso2);
          });
          map.on("mouseenter", "countries-fill", () => {
            map.getCanvas().style.cursor = "pointer";
          });
          map.on("mouseleave", "countries-fill", () => {
            map.getCanvas().style.cursor = "";
            setHover(null);
          });
          map.on("mousemove", "countries-fill", (e: {
            features?: Array<{
              id?: number | string;
              properties?: { iso2?: string; name?: string };
            }>;
            point: { x: number; y: number };
          }) => {
            const f = e.features?.[0];
            const iso2 = f?.properties?.iso2;
            if (!iso2) return;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const stateRaw = (map as any).getFeatureState({
              source: "countries",
              id: f.id,
            });
            const band = (stateRaw as { band?: CountryRisk["band"] })?.band;
            const score = (stateRaw as { score?: number })?.score;
            const signalCount = (stateRaw as { signalCount?: number })
              ?.signalCount;
            setHover({
              iso2,
              name: f.properties?.name ?? iso2,
              risk: band
                ? {
                    country: iso2,
                    band,
                    score: score ?? 0,
                    signalCount: signalCount ?? 0,
                    topDimensions: [],
                  }
                : null,
              x: e.point.x,
              y: e.point.y,
            });
          });

          // ---- Sites: one circle per supplier-as-site ----
          map.addSource("sites", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
            // Auto-generate numeric ids so setFeatureState (used for
            // the hover stroke highlight) has a stable handle.
            generateId: true,
          });
          map.addLayer({
            id: "sites-circle",
            type: "circle",
            source: "sites",
            paint: {
              // Radius scales with recent 90d spend on a sqrt curve so a
              // few outsized suppliers don't blow out the legend. The
              // floor keeps zero-spend sites visible as 4px dots.
              "circle-radius": [
                "interpolate",
                ["linear"],
                ["sqrt", ["max", ["coalesce", ["get", "spend"], 0], 0]],
                0,
                4,
                100,
                6,
                1000,
                10,
                10000,
                16,
                100000,
                24,
              ],
              "circle-color": [
                "match",
                ["get", "band"],
                "high",
                BAND_FILL.high,
                "elevated",
                BAND_FILL.elevated,
                "moderate",
                BAND_FILL.moderate,
                "low",
                BAND_FILL.low,
                "#64748b",
              ],
              "circle-opacity": 0.85,
              "circle-stroke-color": "#0f172a",
              "circle-stroke-width": [
                "case",
                ["boolean", ["feature-state", "hover"], false],
                2,
                0.6,
              ],
            },
          });

          // Site clicks must short-circuit country clicks so a click on
          // a circle deterministically routes to Entity 360 instead of
          // also firing the country-level Signal Browser drilldown.
          // Maplibre fires layer handlers in registration order; we
          // can't cancel from the country handler retroactively, so we
          // stamp `e.originalEvent` and have the country handler bail.
          map.on("click", "sites-circle", (e: {
            features?: Array<{ properties?: { siteId?: string } }>;
            originalEvent?: MouseEvent;
          }) => {
            const f = e.features?.[0];
            const siteId = f?.properties?.siteId;
            if (siteId && onSiteClickRef.current) {
              if (e.originalEvent) {
                (e.originalEvent as unknown as {
                  _siteHandled?: boolean;
                })._siteHandled = true;
              }
              onSiteClickRef.current(siteId);
            }
          });
          // Hover stroke highlight: track the currently-hovered site
          // feature id so the `feature-state.hover` styling actually
          // activates instead of being dead code.
          let hoveredSiteId: string | number | null = null;
          map.on("mouseenter", "sites-circle", () => {
            map.getCanvas().style.cursor = "pointer";
          });
          map.on("mouseleave", "sites-circle", () => {
            map.getCanvas().style.cursor = "";
            if (hoveredSiteId !== null) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (map as any).setFeatureState(
                { source: "sites", id: hoveredSiteId },
                { hover: false },
              );
              hoveredSiteId = null;
            }
            setSiteHover(null);
          });
          map.on("mousemove", "sites-circle", (e: {
            features?: Array<{
              id?: number | string;
              properties?: {
                siteId?: string;
                label?: string;
                country?: string;
                band?: CountryRisk["band"];
                score?: number;
                signalCount?: number;
                spend?: number | null;
              };
            }>;
            point: { x: number; y: number };
          }) => {
            const f = e.features?.[0];
            const p = f?.properties;
            if (!p?.siteId) return;
            if (f?.id !== undefined && f.id !== hoveredSiteId) {
              if (hoveredSiteId !== null) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (map as any).setFeatureState(
                  { source: "sites", id: hoveredSiteId },
                  { hover: false },
                );
              }
              hoveredSiteId = f.id;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (map as any).setFeatureState(
                { source: "sites", id: f.id },
                { hover: true },
              );
            }
            setSiteHover({
              siteId: p.siteId,
              label: p.label ?? p.siteId,
              country: p.country ?? "",
              band: p.band ?? "low",
              score: Number(p.score ?? 0),
              signalCount: Number(p.signalCount ?? 0),
              recentSpend:
                p.spend === null || p.spend === undefined
                  ? null
                  : Number(p.spend),
              x: e.point.x,
              y: e.point.y,
            });
          });

          isReady = true;
          setLoaded(true);
        });
      } catch (err) {
        if (!cancelled) {
          onMapUnavailable(
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    })();

    return () => {
      cancelled = true;
      const m = mapRef.current;
      if (m && typeof m.remove === "function") {
        try {
          m.remove();
        } catch {
          // best-effort cleanup
        }
      }
      mapRef.current = null;
    };
    // We intentionally omit callback deps here: the initialization
    // should run exactly once per mount. The data effect below
    // handles per-`cells` updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Push current cell aggregation into feature-state ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    const byCountry = aggregateCellsByCountry(cells, selectedDimension);

    // Reset all known states first so countries that drop out of the
    // window stop being colored.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const src = (map as any).getSource("countries");
    if (!src) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (src as any)._data as
      | { features: Array<{ id: number; properties: { iso2: string } }> }
      | undefined;
    if (!data) return;

    for (const f of data.features) {
      const r = byCountry.get(f.properties.iso2);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (map as any).setFeatureState(
        { source: "countries", id: f.id },
        r
          ? { band: r.band, score: r.score, signalCount: r.signalCount }
          : { band: null, score: null, signalCount: null },
      );
    }
  }, [cells, loaded, selectedDimension]);

  // ---- Push site points into the sites GeoJSON source ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const src = (map as any).getSource("sites");
    if (!src || typeof src.setData !== "function") return;

    const features = sites
      .filter(
        (s) =>
          typeof s.lat === "number" &&
          typeof s.lng === "number" &&
          Number.isFinite(s.lat) &&
          Number.isFinite(s.lng),
      )
      .map((s) => ({
        type: "Feature" as const,
        geometry: {
          type: "Point" as const,
          coordinates: [s.lng as number, s.lat as number],
        },
        properties: {
          siteId: s.siteId,
          label: s.label,
          country: s.country,
          band: s.band ?? "low",
          score: s.riskScore,
          signalCount: s.signalCount,
          spend: s.recentSpend ?? null,
        },
      }));
    src.setData({ type: "FeatureCollection", features });
  }, [sites, loaded]);

  return (
    <div
      className="relative w-full h-[420px] rounded-md overflow-hidden border bg-muted/30"
      data-testid="risk-heatmap-map"
    >
      <div ref={containerRef} className="absolute inset-0" />
      {!loaded && (
        <div
          className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground bg-background/40"
          data-testid="risk-heatmap-map-loading"
        >
          Loading world map…
        </div>
      )}
      <MapLegend selectedDimension={selectedDimension} />
      {hover && (
        <div
          className="pointer-events-none absolute z-10 rounded border bg-popover px-2 py-1 text-xs shadow-md"
          style={{
            left: Math.min(hover.x + 12, 9999),
            top: Math.max(hover.y - 8, 0),
          }}
          data-testid="risk-heatmap-map-tooltip"
        >
          <div className="font-medium">
            {hover.name}{" "}
            <span className="text-muted-foreground font-mono">
              ({hover.iso2})
            </span>
          </div>
          {hover.risk ? (
            <div className="text-muted-foreground">
              {hover.risk.band} · score {Math.round(hover.risk.score)} ·{" "}
              {hover.risk.signalCount} sig
            </div>
          ) : (
            <div className="text-muted-foreground italic">no signals</div>
          )}
        </div>
      )}
      {siteHover && (
        <div
          className="pointer-events-none absolute z-10 rounded border bg-popover px-2 py-1 text-xs shadow-md max-w-[260px]"
          style={{
            left: Math.min(siteHover.x + 12, 9999),
            top: Math.max(siteHover.y - 8, 0),
          }}
          data-testid="risk-heatmap-map-site-tooltip"
        >
          <div className="font-medium truncate">
            {siteHover.label}{" "}
            <span className="text-muted-foreground font-mono">
              ({siteHover.country})
            </span>
          </div>
          <div className="text-muted-foreground">
            {siteHover.band} · score {Math.round(siteHover.score)} ·{" "}
            {siteHover.signalCount} sig
          </div>
          <div className="text-muted-foreground">
            90d spend:{" "}
            {siteHover.recentSpend === null
              ? "—"
              : formatSpend(siteHover.recentSpend)}
          </div>
        </div>
      )}
    </div>
  );
}

function formatSpend(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

function MapLegend({ selectedDimension }: { selectedDimension?: string }) {
  const items: Array<{ band: CountryRisk["band"]; label: string }> = [
    { band: "low", label: "Low" },
    { band: "moderate", label: "Moderate" },
    { band: "elevated", label: "Elevated" },
    { band: "high", label: "High" },
  ];
  const activeLabel =
    !selectedDimension || selectedDimension === "any"
      ? "any dimension (worst-band wins)"
      : selectedDimension;
  return (
    <div
      className="absolute bottom-2 left-2 z-10 rounded border bg-popover/90 px-2 py-1.5 text-[11px] shadow-sm"
      data-testid="risk-heatmap-map-legend"
    >
      <div
        className="text-muted-foreground uppercase tracking-wide mb-1"
        data-testid="risk-heatmap-map-legend-label"
      >
        Risk band · <span className="normal-case">{activeLabel}</span>
      </div>
      <div className="flex items-center gap-2">
        {items.map((it) => (
          <span key={it.band} className="flex items-center gap-1">
            <span
              className="inline-block w-3 h-3 rounded-sm border"
              style={{
                backgroundColor: BAND_FILL[it.band],
                opacity: 0.7,
                borderColor: BAND_FILL[it.band],
              }}
            />
            {it.label}
          </span>
        ))}
      </div>
    </div>
  );
}
