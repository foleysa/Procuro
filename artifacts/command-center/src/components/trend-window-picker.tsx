import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Date-window options exposed on the FX / BLS / etc. trend charts.
 *
 * Kept short on purpose so the picker fits on one row next to the
 * Indexed/Absolute toggle. The values double as user-facing labels.
 */
export const TREND_WINDOW_OPTIONS = ["30d", "90d", "1y", "5y"] as const;
export type TrendWindow = (typeof TREND_WINDOW_OPTIONS)[number];

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const WINDOW_TO_MS: Record<TrendWindow, number> = {
  "30d": 30 * ONE_DAY_MS,
  "90d": 90 * ONE_DAY_MS,
  "1y": 365 * ONE_DAY_MS,
  "5y": 5 * 365 * ONE_DAY_MS,
};

/** Convert a `TrendWindow` to milliseconds (used to derive `observedAfter`). */
export function trendWindowToMs(window: TrendWindow): number {
  return WINDOW_TO_MS[window];
}

export interface TrendWindowPickerProps {
  value: TrendWindow;
  onChange: (next: TrendWindow) => void;
  /**
   * Prefix used for the `data-testid` on the group and each option, e.g.
   * `"fx-trend"` becomes `fx-trend-window-picker` and
   * `fx-trend-window-30d`.
   */
  testIdPrefix: string;
  className?: string;
}

/**
 * Compact pill-group picker for the chart's date window. Mirrors the
 * visual treatment of the Indexed/Absolute toggle next to it so the
 * two controls read as a single bar.
 */
export function TrendWindowPicker({
  value,
  onChange,
  testIdPrefix,
  className,
}: TrendWindowPickerProps) {
  return (
    <div
      className={cn("inline-flex rounded-md border p-0.5", className)}
      role="group"
      aria-label="Date window"
      data-testid={`${testIdPrefix}-window-picker`}
    >
      {TREND_WINDOW_OPTIONS.map((opt) => (
        <Button
          key={opt}
          type="button"
          size="sm"
          variant={value === opt ? "default" : "ghost"}
          onClick={() => onChange(opt)}
          data-testid={`${testIdPrefix}-window-${opt}`}
          className="h-7 text-xs px-2"
          title={`Show the last ${opt}`}
          aria-pressed={value === opt}
        >
          {opt}
        </Button>
      ))}
    </div>
  );
}
