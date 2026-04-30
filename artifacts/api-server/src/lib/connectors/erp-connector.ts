import type { z } from "zod";
import type { ErpAdapterKey, ErpWatermarks } from "@workspace/db";
import type { IngestPayload } from "../adapters/ingest-writer";
import type { IsCancelledFn } from "../adapters/source-adapter";

/**
 * Contract for live ERP/source-system connectors (Coupa, SAP, Ariba,
 * NetSuite, …). Distinct from `IntelligenceCollector` (which fetches
 * external market signals into `marketSignalsTable`) and from the CSV
 * adapter (which lands a one-off file). A connector pulls structured
 * procurement data (suppliers / contracts / POs / invoices / payments)
 * from a tenant-bound upstream over HTTPS and yields the standard
 * `IngestPayload` shape; the sync handler then hands that payload to
 * `writeIngestPayload` for the same dedup/upsert path the CSV ingest
 * uses.
 *
 * Contract metadata is intentionally aligned with `CollectorContract`
 * (postureClass / disclosureTier / jurisdiction / retentionDays) so the
 * Fusion Center / disclosure renderer can treat ERP-derived facts the
 * same way it treats market-intel facts. ERP connectors are always
 * `tier-2_aggregated_disclosed` because the upstream is the tenant's
 * own data — there's no third-party redistribution concern, but the
 * tier is deliberately not `tier-1_anonymous` so the surface still
 * carries source attribution.
 */
import type {
  PostureClass,
  DisclosureTier,
  Jurisdiction,
} from "@workspace/intelligence";

export type ErpEntity =
  | "suppliers"
  | "contracts"
  | "purchase_orders"
  | "invoices"
  | "payments";

export interface ErpFetchProgress {
  entity: ErpEntity;
  pagesFetched: number;
  recordsFetched: number;
}

/**
 * Result of a single connector pull. The handler turns this into the
 * job result, advances per-entity watermarks on the connection row,
 * and forwards `payload` to `writeIngestPayload`.
 */
export interface ErpFetchResult {
  payload: IngestPayload;
  /**
   * New watermark map after the pull. Entries omitted are left
   * unchanged on the connection. ISO-8601 UTC strings.
   */
  nextWatermarks: ErpWatermarks;
  /**
   * Per-entity fetch counters surfaced into the job result for the UI.
   */
  pagesByEntity: Partial<Record<ErpEntity, number>>;
  recordsByEntity: Partial<Record<ErpEntity, number>>;
}

export interface ErpFetchArgs<TCreds, TSettings> {
  orgId: string;
  connectionId: string;
  credentials: TCreds;
  settings: TSettings;
  /**
   * Per-entity high-watermark from the previous successful sync. The
   * connector should request only records updated after the watermark
   * for each entity. Missing keys imply "no prior sync" — fetch from
   * the beginning (or whatever the upstream's "all" semantic is).
   */
  watermarks: ErpWatermarks;
  isCancelled?: IsCancelledFn;
  /**
   * Override the global `fetch` used by the adapter — tests pass a
   * stub that responds without going to the network.
   */
  fetchImpl?: typeof fetch;
}

export interface ErpConnector<
  CredentialsSchema extends z.ZodTypeAny = z.ZodTypeAny,
  SettingsSchema extends z.ZodTypeAny = z.ZodTypeAny,
> {
  /** Stable adapter key (`coupa`, `sap`, `ariba`, …). Unique. */
  readonly key: ErpAdapterKey;
  /** Human-readable label for the registry / UI. */
  readonly label: string;
  /** Brief description shown on the Integrations page form. */
  readonly description: string;

  // -- Disclosure metadata ------------------------------------------
  readonly postureClass: PostureClass;
  readonly disclosureTier: DisclosureTier;
  readonly jurisdiction: Jurisdiction;
  /** Retention budget for any cached upstream payloads (days). */
  readonly retentionDays: number;

  // -- Credentials / settings shapes --------------------------------
  /** Zod schema validating the decrypted credentials object. */
  readonly credentialsSchema: CredentialsSchema;
  /** Zod schema validating the non-secret connection settings. */
  readonly settingsSchema: SettingsSchema;

  /**
   * Validate that the upstream is reachable with the supplied
   * credentials. Used by the "Test connection" button on the
   * Integrations form so an operator gets immediate feedback before
   * saving a broken config.
   */
  testConnection(args: {
    credentials: z.infer<CredentialsSchema>;
    settings: z.infer<SettingsSchema>;
    fetchImpl?: typeof fetch;
  }): Promise<{ ok: true } | { ok: false; error: string }>;

  /**
   * Pull all entities since the supplied watermarks. The handler is
   * responsible for advancing the connection's stored watermark map
   * with `nextWatermarks` only on a successful sync — if the call
   * throws, watermarks are left untouched so the next attempt starts
   * from the same point.
   */
  fetchAll(
    args: ErpFetchArgs<z.infer<CredentialsSchema>, z.infer<SettingsSchema>>,
  ): Promise<ErpFetchResult>;
}

/**
 * In-memory registry of ERP connectors. Booted at server start
 * alongside the collectors registry. The schema-level
 * `ErpAdapterKey` enum guarantees each registered connector
 * has a unique stable key.
 */
const REGISTRY = new Map<ErpAdapterKey, ErpConnector>();

export function registerErpConnector(connector: ErpConnector): void {
  if (REGISTRY.has(connector.key)) {
    throw new Error(
      `ERP connector "${connector.key}" is already registered`,
    );
  }
  REGISTRY.set(connector.key, connector);
}

export function getErpConnector(
  key: ErpAdapterKey,
): ErpConnector | undefined {
  return REGISTRY.get(key);
}

export function listErpConnectors(): ReadonlyArray<ErpConnector> {
  return Array.from(REGISTRY.values());
}

/**
 * Test-only: clears the in-memory registry. Used by integration tests
 * so each test starts from a known state.
 */
export function _clearErpConnectorsForTest(): void {
  REGISTRY.clear();
}
