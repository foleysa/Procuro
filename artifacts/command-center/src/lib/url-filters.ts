/**
 * `?filter=key:value` repeatable URL-param convention (#209 step 7).
 *
 * Existing destination pages (alerts, opportunities, approvals,
 * operations) historically drove all filter UI from local React state
 * — none read URL params. The Today aggregator's "Open →" deep-links
 * need to land on a pre-filtered slice, so #209 introduces ONE
 * convention that any of the four (and any future card) can opt into:
 *
 *   /alerts?filter=state:open&filter=severity:critical&filter=severity:high
 *
 * - The param name is always `filter`.
 * - Each occurrence is `<key>:<value>`. Repeats on the same key are an
 *   OR (a multi-select).
 * - Unknown keys are silently ignored — destination pages whitelist
 *   their own keys, so adding a stray `?filter=foo:bar` to a deep-link
 *   is non-breaking.
 *
 * This helper is intentionally tiny and zero-dependency: it parses a
 * search string (with or without leading `?`) into a `Map<key, Set<value>>`.
 * Pages then apply their own whitelist.
 *
 * Documented in `docs/command-center-ia.md` so #204 and any future
 * card additions inherit it instead of inventing new query strings.
 */
export type FilterMap = Map<string, Set<string>>;

export function parseFilters(search: string | null | undefined): FilterMap {
  const out: FilterMap = new Map();
  if (!search) return out;
  const qs = search.startsWith("?") ? search.slice(1) : search;
  const params = new URLSearchParams(qs);
  for (const raw of params.getAll("filter")) {
    const idx = raw.indexOf(":");
    if (idx <= 0 || idx === raw.length - 1) continue;
    const key = raw.slice(0, idx);
    const value = raw.slice(idx + 1);
    if (!out.has(key)) out.set(key, new Set());
    out.get(key)!.add(value);
  }
  return out;
}

/**
 * Convenience: pluck the first value for `key` from a parsed filter
 * map, or return `fallback`. Use this for single-select filters where
 * the page UI only renders one value at a time (e.g. the alerts page's
 * "state" select, which is single-choice).
 */
export function firstFilterValue(
  filters: FilterMap,
  key: string,
  fallback: string,
): string {
  const set = filters.get(key);
  if (!set || set.size === 0) return fallback;
  return [...set][0]!;
}
