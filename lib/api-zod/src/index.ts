export * from "./generated/api";
export * from "./generated/types";

// Resolve TS2308 ambiguity: orval emits a path-params zod schema named
// `ListErpConnectionRunsParams` (just `{ id }`) AND a combined query+path
// TypeScript type with the same name. The explicit re-export below makes
// the zod schema win for `ListErpConnectionRunsParams` here; consumers
// that need the combined TS type can import it from
// `@workspace/api-zod/generated/types/listErpConnectionRunsParams`.
export { ListErpConnectionRunsParams } from "./generated/api";

// Same TS2308 ambiguity for the bulk-import response: orval emits both
// a zod runtime schema (in `generated/api`) and a TypeScript interface
// (in `generated/types/bulkAddWatchedIssuersResponse`) with the same
// name. The explicit re-export makes the zod schema win at this barrel;
// consumers that need the TS type can import it directly from the
// generated types path.
export { BulkAddWatchedIssuersResponse } from "./generated/api";

// Same TS2308 ambiguity for the engine-access denial POST body (#207).
export { RecordEngineAccessDenialBody } from "./generated/api";
