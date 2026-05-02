export * from "./generated/api";
export * from "./generated/types";

// Resolve TS2308 ambiguity: orval emits a path-params zod schema named
// `ListErpConnectionRunsParams` (just `{ id }`) AND a combined query+path
// TypeScript type with the same name. The explicit re-export below makes
// the zod schema win for `ListErpConnectionRunsParams` here; consumers
// that need the combined TS type can import it from
// `@workspace/api-zod/generated/types/listErpConnectionRunsParams`.
export { ListErpConnectionRunsParams } from "./generated/api";
