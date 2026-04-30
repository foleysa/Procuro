import { Badge } from "@/components/ui/badge";
import { TrendingDown, TrendingUp, Minus } from "lucide-react";

export interface SeriesDeltaInput {
  /** Series label as shown to the user (e.g. "EUR/USD" or "PPI: Iron and steel"). */
  label: string;
  /** Indicator color matching the line on the chart. */
  color: string;
  /**
   * Earliest visible value in the active window. `null` if the series has
   * no data points (we then render no badge for it).
   */
  first: number | null;
  /** Latest visible value in the active window. */
  last: number | null;
  /** ISO timestamp of the first observation, used in the tooltip. */
  firstAt?: string | null;
  /** ISO timestamp of the last observation, used in the tooltip. */
  lastAt?: string | null;
}

export interface SeriesDeltaCalloutsProps {
  series: readonly SeriesDeltaInput[];
  /**
   * Human-readable label for the visible window, e.g. "90d" or "5y".
   * Shown as a leading caption so the percentage isn't ambiguous.
   */
  windowLabel: string;
  /** Test id for end-to-end coverage. */
  "data-testid"?: string;
}

/**
 * Compact "+3.2% over 90d" badge row rendered above FX/BLS/ECB charts.
 *
 * The numbers are computed client-side from the same data points the
 * chart already has, so there is no extra API call. We deliberately
 * render one badge per series the user has toggled on (callers filter
 * the input list) — empty input means we render nothing instead of an
 * empty bar that takes up vertical space.
 */
export function SeriesDeltaCallouts({
  series,
  windowLabel,
  "data-testid": testId,
}: SeriesDeltaCalloutsProps) {
  const usable = series.filter(
    (s) => s.first !== null && s.last !== null && s.first !== 0,
  );
  if (usable.length === 0) return null;

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-testid={testId ?? "series-delta-callouts"}
    >
      <span className="text-xs text-muted-foreground">
        Window delta ({windowLabel}):
      </span>
      {usable.map((s) => {
        const pct = ((s.last! - s.first!) / s.first!) * 100;
        const sign = pct > 0 ? "+" : "";
        const tone =
          Math.abs(pct) < 0.05
            ? "neutral"
            : pct > 0
              ? "up"
              : "down";
        const Icon =
          tone === "up" ? TrendingUp : tone === "down" ? TrendingDown : Minus;
        const variant =
          tone === "up"
            ? "default"
            : tone === "down"
              ? "destructive"
              : "secondary";
        const tooltip = [
          `${s.label}: ${s.first!.toFixed(4)} → ${s.last!.toFixed(4)}`,
          s.firstAt && s.lastAt
            ? `${new Date(s.firstAt).toLocaleDateString()} → ${new Date(s.lastAt).toLocaleDateString()}`
            : null,
        ]
          .filter(Boolean)
          .join("\n");
        return (
          <Badge
            key={s.label}
            variant={variant}
            className="gap-1 px-2 py-0.5 text-xs"
            title={tooltip}
            data-testid={`series-delta-${s.label}`}
          >
            <span
              className="inline-block w-1.5 h-1.5 rounded-full"
              style={{ backgroundColor: s.color }}
              aria-hidden
            />
            <span className="font-medium">{s.label}</span>
            <Icon className="w-3 h-3" aria-hidden />
            <span>
              {sign}
              {pct.toFixed(pct === 0 ? 1 : Math.abs(pct) >= 10 ? 1 : 2)}%
            </span>
          </Badge>
        );
      })}
    </div>
  );
}
