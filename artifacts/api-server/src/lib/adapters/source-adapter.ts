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

export interface SyncResult {
  recordsProcessed: number;
  recordsCreated: number;
  recordsUpdated: number;
  recordsDeleted: number;
  cursor: SourceCursor;
  durationMs: number;
}

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
  }): Promise<SyncResult>;

  /** Incremental sync from a cursor — implementer defines cursor semantics. */
  incrementalSync(args: {
    orgId: string;
    config: TConfig;
    cursor: SourceCursor;
    onProgress?: (p: SyncProgress) => Promise<void> | void;
  }): Promise<SyncResult>;

  /** Optional: idempotent single-record delete. */
  deleteRecord?(args: {
    orgId: string;
    type: string;
    externalId: string;
  }): Promise<void>;
}
