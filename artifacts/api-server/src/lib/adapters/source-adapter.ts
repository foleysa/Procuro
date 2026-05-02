/**
 * Phase 1 contract — every internal-data ingestion source implements this.
 *
 * The adapter is the only abstraction the agent and the rest of the platform
 * use to read tenant data. Today: CSV. Tomorrow: SAP, Coupa, Ariba, NetSuite,
 * Workday, Microsoft Dynamics, Infor, Jaggaer.
 *
 * Idempotent upsert keyed on (tenant_id, source_system, source_external_id).
 */

export type SourceCursor = string | null;

export interface SyncProgress {
  recordsProcessed: number;
  recordsTotal?: number;
  message?: string;
  cursor?: string;
}

/**
 * Per-row warning surfaced in a `SyncResult`. Used by ingest adapters to
 * report rows that were skipped (rather than failing the whole batch) so
 * the operator can see exactly which records were dropped from a
 * partially-successful import — e.g. a CSV/JSON payload that mixes
 * known entity types with one we don't recognise.
 *
 * Task #93: instead of throwing `UnrecoverableJobError` on the first
 * unknown record kind and forcing the operator to clean the file before
 * any rows land, we accumulate warnings and let the rest of the file
 * ingest. The warnings are returned in `SyncResult.warnings` and are
 * rendered verbatim in the job-result JSON viewer on the System page.
 */
export interface IngestWarning {
  /**
   * Stable machine-readable category. Today only
   * `"unknown_record_type"` is emitted, but downstream callers may add
   * `"missing_required_field"`, `"orphan_reference"`, etc. Kept open
   * (string union widening) so adding a new code is non-breaking.
   */
  code: "unknown_record_type" | (string & {});
  /**
   * Path-style locator for the offending field, e.g.
   * `"frobnicators[0]"` or `"suppliers[3].externalId"`. Optional —
   * not every warning has a clean field path (e.g. a non-array unknown
   * top-level key).
   */
  field?: string;
  /**
   * Optional `externalId` captured from the row when one was present.
   * Lets the operator grep the source file directly. Truncated to
   * 200 chars by emitters to keep the result row payload bounded.
   */
  externalId?: string;
  /** Human-readable explanation. Kept short and free of secrets. */
  reason: string;
}

export interface SyncResult {
  recordsProcessed: number;
  recordsCreated: number;
  recordsUpdated: number;
  recordsDeleted: number;
  /**
   * Number of payload rows that were intentionally skipped (e.g. an
   * unknown record type the adapter doesn't know how to handle). A
   * skipped row produces a corresponding entry in `warnings` and does
   * NOT count toward `recordsProcessed` / `recordsCreated`. Optional
   * for back-compat with adapters that have nothing to skip.
   */
  recordsSkipped?: number;
  /**
   * Per-row warnings accumulated during the sync. Empty / omitted
   * when nothing was skipped. The handler returns this verbatim in
   * the job result so the operator can inspect each dropped row.
   */
  warnings?: IngestWarning[];
  cursor: SourceCursor;
  durationMs: number;
}

/**
 * Optional cooperative-cancellation hook. The job worker passes
 * `() => isJobCancelRequested(job.id)` so an operator pressing Cancel on
 * the System / Jobs page short-circuits long-running ingests within
 * seconds of a batch boundary instead of waiting for the entire feed to
 * drain. Implementations should await it at safe checkpoints (between
 * batches, between pages) and let the thrown
 * `Error("Cancelled by operator")` propagate — the queue's `processOnce`
 * normalises that into the terminal `failed` state.
 */
export type IsCancelledFn = () => Promise<boolean>;

export interface SourceAdapter<TConfig = Record<string, unknown>> {
  /** Stable adapter key, e.g. "csv", "mock_erp_sap" */
  readonly key: string;
  /** Human-readable label for the registry/UI */
  readonly label: string;

  /** Full sync — wipes nothing, but pulls the entire dataset and upserts. */
  fullSync(args: {
    orgId: string;
    config: TConfig;
    onProgress?: (p: SyncProgress) => Promise<void> | void;
    isCancelled?: IsCancelledFn;
  }): Promise<SyncResult>;

  /** Incremental sync from a cursor — implementer defines cursor semantics. */
  incrementalSync(args: {
    orgId: string;
    config: TConfig;
    cursor: SourceCursor;
    onProgress?: (p: SyncProgress) => Promise<void> | void;
    isCancelled?: IsCancelledFn;
  }): Promise<SyncResult>;

  /** Optional: idempotent single-record delete. */
  deleteRecord?(args: {
    orgId: string;
    type: string;
    externalId: string;
  }): Promise<void>;
}
