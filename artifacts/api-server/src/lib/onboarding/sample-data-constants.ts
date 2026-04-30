/**
 * Sentinel `source_system` value used to mark every row inserted by the
 * onboarding sample-data loader. The DELETE endpoint (and the readiness
 * check) rely on this exact constant — keep it in sync everywhere.
 */
export const SAMPLE_DATA_SOURCE_SYSTEM = "sample_data";
