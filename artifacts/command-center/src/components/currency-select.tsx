import { useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import {
  COMMON_CURRENCIES,
  isCommonCurrency,
} from "@/lib/currencies";

/**
 * Sentinel option values for the Select component. Radix Select item
 * values must be non-empty, so we can't use "" for the "no selection"
 * branches — these distinct sentinels stand in for the semantic states.
 */
const NONE = "__none__";
const OTHER = "__other__";

/**
 * Currency picker — a Radix `Select` populated from the curated
 * `COMMON_CURRENCIES` list, with two escape hatches:
 *
 *   - `(none)` — clears the value (when `allowClear` is on)
 *   - `Other…` — reveals a 3-letter free-text input for the long-tail
 *     ISO 4217 codes that aren't in the dropdown
 *
 * The component is fully controlled. The parent receives `value`
 * exactly as the user picks it: an uppercased 3-letter code, or `null`
 * when cleared. Empty strings are normalised to `null` to match the
 * server-side PATCH semantics.
 */
export function CurrencySelect({
  value,
  onChange,
  allowClear = true,
  disabled = false,
  placeholder = "Select currency…",
  triggerClassName,
  testIdPrefix = "currency-select",
}: {
  value: string | null;
  onChange: (next: string | null) => void;
  allowClear?: boolean;
  disabled?: boolean;
  placeholder?: string;
  triggerClassName?: string;
  testIdPrefix?: string;
}) {
  const upper = value ? value.toUpperCase() : null;
  const valueIsCommon = isCommonCurrency(upper);

  // Custom-mode tracks whether the user explicitly picked "Other…" so
  // we keep the text input visible even after they type a value that
  // would otherwise resolve back to the dropdown branch.
  const [customMode, setCustomMode] = useState<boolean>(
    !!upper && !valueIsCommon,
  );
  const [customDraft, setCustomDraft] = useState<string>(
    !valueIsCommon && upper ? upper : "",
  );

  // Re-sync when the parent feeds a new value (e.g. server refetch).
  useEffect(() => {
    if (upper && !isCommonCurrency(upper)) {
      setCustomMode(true);
      setCustomDraft(upper);
    } else if (!upper) {
      setCustomMode(false);
      setCustomDraft("");
    } else {
      // Common-list selection wins over a stale custom draft.
      setCustomMode(false);
    }
  }, [upper]);

  const selectValue = customMode
    ? OTHER
    : upper && valueIsCommon
      ? upper
      : upper === null
        ? NONE
        : OTHER;

  const handleSelectChange = (next: string) => {
    if (next === NONE) {
      setCustomMode(false);
      setCustomDraft("");
      onChange(null);
      return;
    }
    if (next === OTHER) {
      setCustomMode(true);
      // Don't fire onChange yet — wait for the user to type a valid
      // 3-letter code so we don't transiently emit a half-formed value.
      return;
    }
    setCustomMode(false);
    setCustomDraft("");
    onChange(next);
  };

  const handleCustomChange = (raw: string) => {
    const next = raw.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3);
    setCustomDraft(next);
    if (next.length === 3) {
      onChange(next);
    } else if (next.length === 0) {
      onChange(null);
    }
    // 1- or 2-letter intermediates are intentionally not propagated;
    // the server validator would 400 on them.
  };

  // The "current" value may be a code that's neither in the curated
  // list nor empty (e.g. an older supplier billing in HRK). We surface
  // it as a one-off option at the top of the menu so the user can see
  // what's currently set without flipping into custom mode.
  const showOneOffCurrent =
    upper !== null && !valueIsCommon && !customMode;

  return (
    <div className="space-y-2">
      <Select
        value={selectValue}
        onValueChange={handleSelectChange}
        disabled={disabled}
      >
        <SelectTrigger
          className={triggerClassName}
          data-testid={`${testIdPrefix}-trigger`}
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {allowClear && (
            <SelectItem value={NONE} data-testid={`${testIdPrefix}-option-none`}>
              <span className="text-muted-foreground">(none)</span>
            </SelectItem>
          )}
          {showOneOffCurrent && upper && (
            <SelectItem
              value={upper}
              data-testid={`${testIdPrefix}-option-${upper}`}
            >
              {upper} — current
            </SelectItem>
          )}
          {COMMON_CURRENCIES.map((c) => (
            <SelectItem
              key={c.code}
              value={c.code}
              data-testid={`${testIdPrefix}-option-${c.code}`}
            >
              {c.label}
            </SelectItem>
          ))}
          <SelectItem value={OTHER} data-testid={`${testIdPrefix}-option-other`}>
            Other…
          </SelectItem>
        </SelectContent>
      </Select>

      {customMode && (
        <Input
          value={customDraft}
          onChange={(e) => handleCustomChange(e.target.value)}
          placeholder="3-letter ISO code, e.g. HRK"
          maxLength={3}
          className="font-mono uppercase w-32"
          data-testid={`${testIdPrefix}-custom-input`}
          disabled={disabled}
        />
      )}
    </div>
  );
}
