/**
 * `StructuralIngestError` marks a CSV / mock-ERP ingest failure that is
 * permanent for the given input — retrying with the same payload cannot
 * possibly succeed. The job worker's `wrapStructuralError` consults the
 * `unrecoverable` brand on this class (and on `UnrecoverableJobError`)
 * to short-circuit retry budget consumption: such failures land at
 * `status='failed'` after attempt #1 instead of burning the configured
 * retries plus the exponential-backoff delays.
 *
 * Use this for input-shaped problems the operator must fix in their
 * source data or request, e.g.:
 *   - a CSV that targets an unsupported `entity` query param;
 *   - a CSV row that references a record kind we do not know how to
 *     resolve (an "unknown record reference");
 *   - structurally invalid request bodies caught by Zod validation in
 *     the ingest routes (see #99 — mock-ERP).
 *
 * Why a dedicated class instead of `UnrecoverableJobError`
 * --------------------------------------------------------
 * `UnrecoverableJobError` lives in `lib/jobs/queue.ts` and is wired into
 * the worker's failure machinery; importing it from the CSV adapter or
 * from a route handler would pull the queue module into otherwise
 * queue-free modules. `StructuralIngestError` keeps the dependency arrow
 * pointing the right way: the handlers depend on the adapters, not the
 * other way around. The handlers' `wrapStructuralError` recognises both
 * brands so the end-to-end retry behaviour is identical.
 *
 * Field-level context
 * -------------------
 * Optional `field` and `value` fields capture WHERE the structural
 * problem lives so the dashboard can render an actionable hint without
 * the operator hunting through stack traces. Both are kept short and
 * MUST NOT contain caller-supplied free-form text outside of safe
 * identifiers and quoted literals.
 */
export class StructuralIngestError extends Error {
  readonly unrecoverable = true as const;
  readonly field?: string;
  readonly value?: string;

  constructor(
    message: string,
    options?: { cause?: unknown; field?: string; value?: string },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "StructuralIngestError";
    if (options?.field !== undefined) this.field = options.field;
    if (options?.value !== undefined) this.value = options.value;
  }
}

/**
 * Type-guard for "this thrown value is structurally permanent". Returns
 * true for `StructuralIngestError`, for any error that opted in via the
 * `unrecoverable: true` brand, and for `UnrecoverableJobError` from the
 * queue (matched structurally to avoid the import cycle described
 * above).
 */
export function isStructuralIngestError(err: unknown): boolean {
  if (err instanceof StructuralIngestError) return true;
  if (err === null || typeof err !== "object") return false;
  const branded = (err as { unrecoverable?: unknown }).unrecoverable;
  if (branded === true) return true;
  const name = (err as { name?: unknown }).name;
  if (name === "UnrecoverableJobError") return true;
  return false;
}
