/**
 * Re-export hub for ERP connector types and registry.
 *
 * All types now live in the unified ingestion adapter module
 * (`../adapters/source-adapter.ts`). This file exists so that
 * existing imports from `"../connectors/erp-connector"` continue
 * to resolve without a codebase-wide search-and-replace.
 */
export type {
  ErpEntity,
  ErpFetchProgress,
  ErpFetchResult,
  ErpFetchArgs,
  ErpIngestAdapter,
  ErpConnector,
  IngestAdapter,
  IsCancelledFn,
} from "../adapters/source-adapter";

export {
  registerErpConnector,
  getErpConnector,
  listErpConnectors,
  _clearErpConnectorsForTest,
} from "../adapters/source-adapter";
