/**
 * Unified ingestion adapter contract.
 *
 * Every data-ingestion source — whether it writes directly to the DB
 * (CSV, mock-ERP) or fetches upstream data for the handler to write
 * (Coupa, NetSuite, Ariba) — implements one of the two concrete shapes
 * in the `IngestAdapter` discriminated union:
 *
 *   • `DirectIngestAdapter`  — handles its own DB writes via
 *     `fullSync` / `incrementalSync`.  Used by CSV and mock-ERP.
 *
 *   • `ErpIngestAdapter`     — fetches structured data from an
 *     upstream API via `fetchAll` and returns it for the sync handler
 *     to persist.  Used by live ERP connectors (Coupa, NetSuite,
 *     Ariba, …).
 *
 * Shared supporting types (`SyncResult`, `SyncProgress`,
 * `IsCancelledFn`, `IngestWarning`, etc.) are defined once here so
 * both adapter flavours — and their consumers — import from a single
 * module.
 *
 * Idempotent upsert keyed on (tenant_id, source_system, source_external_id).
 */

import type { z } from "zod";
import type { ErpAdapterKey, ErpWatermarks } from "@workspace/db";
import type { IngestPayload } from "./ingest-writer";
import type {
  PostureClass,
  DisclosureTier,
  Jurisdiction,
} from "@workspace/intelligence";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

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
  code: "unknown_record_type" | (string & {});
  field?: string;
  externalId?: string;
  reason: string;
}

export interface SyncResult {
  recordsProcessed: number;
  recordsCreated: number;
  recordsUpdated: number;
  recordsDeleted: number;
  recordsSkipped?: number;
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

// ---------------------------------------------------------------------------
// ERP-specific types (used by ErpIngestAdapter and its consumers)
// ---------------------------------------------------------------------------

export type ErpEntity =
  | "suppliers"
  | "contracts"
  | "purchase_orders"
  | "invoices"
  | "payments"
  | "statements_of_work"
  | "rate_cards"
  | "time_entries";

export interface ErpFetchProgress {
  entity: ErpEntity;
  pagesFetched: number;
  recordsFetched: number;
}

export interface ErpFetchResult {
  payload: IngestPayload;
  nextWatermarks: ErpWatermarks;
  pagesByEntity: Partial<Record<ErpEntity, number>>;
  recordsByEntity: Partial<Record<ErpEntity, number>>;
}

export interface ErpFetchArgs<TCreds, TSettings> {
  orgId: string;
  connectionId: string;
  credentials: TCreds;
  settings: TSettings;
  watermarks: ErpWatermarks;
  isCancelled?: IsCancelledFn;
  fetchImpl?: typeof fetch;
}

// ---------------------------------------------------------------------------
// DirectIngestAdapter — adapters that handle their own DB writes
// ---------------------------------------------------------------------------

export interface DirectIngestAdapter<TConfig = Record<string, unknown>> {
  readonly adapterType: "direct";
  readonly key: string;
  readonly label: string;

  fullSync(args: {
    orgId: string;
    config: TConfig;
    onProgress?: (p: SyncProgress) => Promise<void> | void;
    isCancelled?: IsCancelledFn;
  }): Promise<SyncResult>;

  incrementalSync(args: {
    orgId: string;
    config: TConfig;
    cursor: SourceCursor;
    onProgress?: (p: SyncProgress) => Promise<void> | void;
    isCancelled?: IsCancelledFn;
  }): Promise<SyncResult>;

  deleteRecord?(args: {
    orgId: string;
    type: string;
    externalId: string;
  }): Promise<void>;
}

// ---------------------------------------------------------------------------
// ErpIngestAdapter — adapters that fetch data for the handler to persist
// ---------------------------------------------------------------------------

export interface ErpIngestAdapter<
  CredentialsSchema extends z.ZodTypeAny = z.ZodTypeAny,
  SettingsSchema extends z.ZodTypeAny = z.ZodTypeAny,
> {
  readonly adapterType: "erp";
  readonly key: ErpAdapterKey;
  readonly label: string;
  readonly description: string;

  readonly postureClass: PostureClass;
  readonly disclosureTier: DisclosureTier;
  readonly jurisdiction: Jurisdiction;
  readonly retentionDays: number;

  readonly credentialsSchema: CredentialsSchema;
  readonly settingsSchema: SettingsSchema;

  testConnection(args: {
    credentials: z.infer<CredentialsSchema>;
    settings: z.infer<SettingsSchema>;
    fetchImpl?: typeof fetch;
  }): Promise<{ ok: true } | { ok: false; error: string }>;

  fetchAll(
    args: ErpFetchArgs<z.infer<CredentialsSchema>, z.infer<SettingsSchema>>,
  ): Promise<ErpFetchResult>;
}

// ---------------------------------------------------------------------------
// Unified type
// ---------------------------------------------------------------------------

export type IngestAdapter = DirectIngestAdapter | ErpIngestAdapter;

// ---------------------------------------------------------------------------
// Back-compat aliases
// ---------------------------------------------------------------------------

export type SourceAdapter<TConfig = Record<string, unknown>> =
  DirectIngestAdapter<TConfig>;

export type ErpConnector<
  CredentialsSchema extends z.ZodTypeAny = z.ZodTypeAny,
  SettingsSchema extends z.ZodTypeAny = z.ZodTypeAny,
> = ErpIngestAdapter<CredentialsSchema, SettingsSchema>;

// ---------------------------------------------------------------------------
// Unified registry
// ---------------------------------------------------------------------------

const ERP_REGISTRY = new Map<ErpAdapterKey, ErpIngestAdapter>();

export function registerErpConnector(connector: ErpIngestAdapter): void {
  if (ERP_REGISTRY.has(connector.key)) {
    throw new Error(
      `ERP connector "${connector.key}" is already registered`,
    );
  }
  ERP_REGISTRY.set(connector.key, connector);
}

export function getErpConnector(
  key: ErpAdapterKey,
): ErpIngestAdapter | undefined {
  return ERP_REGISTRY.get(key);
}

export function listErpConnectors(): ReadonlyArray<ErpIngestAdapter> {
  return Array.from(ERP_REGISTRY.values());
}

export function _clearErpConnectorsForTest(): void {
  ERP_REGISTRY.clear();
}
