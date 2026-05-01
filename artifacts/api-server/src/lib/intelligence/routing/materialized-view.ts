import { pool } from "@workspace/db";
import { logger } from "../../logger";

/**
 * Bootstrap the `v_category_lever_mappings` materialized view + its
 * refresh trigger. Idempotent: safe to invoke on every server boot.
 *
 * The view is the read-side join of `category_bands` × `lever_bands`
 * on `band` — this is the single query the routing helper hits when
 * answering "which levers apply to category X?". Materializing it
 * keeps that answer cheap as the truth tables grow.
 *
 * Refresh strategy
 * ----------------
 * INSERT/DELETE on either truth table fires a STATEMENT-level trigger
 * that calls `REFRESH MATERIALIZED VIEW CONCURRENTLY`. UPDATEs to
 * `confidence_weight` (a hot path during the learning loop) do not
 * trigger refresh — those land via the per-cycle scheduled refresh
 * (see `refreshCategoryLeverMappings`) so we don't thrash the view on
 * every tiny weight tweak.
 *
 * `CONCURRENTLY` requires a unique index on the materialized view.
 * The architecture explicitly allows a single (category, lever) pair
 * to coexist across multiple bands (e.g. IRON_STEEL is both
 * `indexable` and `concentrated` — it has tracked indices AND a
 * concentrated supplier set). The unique key MUST therefore include
 * `band` to avoid collisions on dual-band rows; otherwise the same
 * (category, lever) gets emitted by both bands and the unique index
 * would explode under concurrent refresh.
 *
 * `fit_rank` is included for completeness even though `(band, lever)`
 * already determines it via `lever_bands`; defense-in-depth against
 * future schema changes that allow per-band `fit_rank` overrides.
 */
const VIEW_DDL = `
CREATE MATERIALIZED VIEW IF NOT EXISTS v_category_lever_mappings AS
SELECT
  cb.category_code,
  lb.lever_id,
  cb.band,
  cb.confidence_weight,
  lb.fit_rank,
  cb.source AS category_source,
  cb.created_at AS category_created_at,
  lb.created_at AS lever_created_at
FROM category_bands cb
JOIN lever_bands lb USING (band);

CREATE UNIQUE INDEX IF NOT EXISTS v_category_lever_mappings_uq
  ON v_category_lever_mappings (category_code, lever_id, band, fit_rank);
CREATE INDEX IF NOT EXISTS v_category_lever_mappings_cat_idx
  ON v_category_lever_mappings (category_code);
CREATE INDEX IF NOT EXISTS v_category_lever_mappings_lever_idx
  ON v_category_lever_mappings (lever_id);
`;

const TRIGGER_DDL = `
CREATE OR REPLACE FUNCTION refresh_v_category_lever_mappings()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- The refresh runs in a deferred transaction — for a fresh install
  -- the view may not yet have its unique index populated, so fall back
  -- to a non-concurrent refresh on first run.
  BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY v_category_lever_mappings;
  EXCEPTION WHEN OTHERS THEN
    REFRESH MATERIALIZED VIEW v_category_lever_mappings;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_refresh_v_clm_on_cat_bands ON category_bands;
CREATE TRIGGER trg_refresh_v_clm_on_cat_bands
AFTER INSERT OR DELETE ON category_bands
FOR EACH STATEMENT
EXECUTE FUNCTION refresh_v_category_lever_mappings();

DROP TRIGGER IF EXISTS trg_refresh_v_clm_on_lever_bands ON lever_bands;
CREATE TRIGGER trg_refresh_v_clm_on_lever_bands
AFTER INSERT OR DELETE ON lever_bands
FOR EACH STATEMENT
EXECUTE FUNCTION refresh_v_category_lever_mappings();
`;

let bootstrapped = false;

/**
 * Create the materialized view + triggers if they don't exist, and seed
 * the view from current truth-table contents. Safe to call repeatedly.
 */
export async function bootstrapCategoryLeverMappings(): Promise<void> {
  if (bootstrapped) return;
  await pool.query(VIEW_DDL);
  await pool.query(TRIGGER_DDL);
  // Always run a non-concurrent refresh on bootstrap to populate the
  // view from any rows that were inserted before the trigger existed.
  await pool.query("REFRESH MATERIALIZED VIEW v_category_lever_mappings");
  bootstrapped = true;
  logger.info(
    { view: "v_category_lever_mappings" },
    "Routing materialized view bootstrapped",
  );
}

/**
 * Force-refresh the materialized view. Called by the per-cycle health
 * job to pick up `confidence_weight` UPDATEs (the trigger only handles
 * INSERT/DELETE).
 */
export async function refreshCategoryLeverMappings(): Promise<void> {
  try {
    await pool.query(
      "REFRESH MATERIALIZED VIEW CONCURRENTLY v_category_lever_mappings",
    );
  } catch (err) {
    logger.warn(
      { err },
      "CONCURRENTLY refresh failed, falling back to blocking refresh",
    );
    await pool.query("REFRESH MATERIALIZED VIEW v_category_lever_mappings");
  }
}

/** Test-only: force re-bootstrap on next call. */
export function __resetMaterializedViewBootstrap(): void {
  bootstrapped = false;
}
