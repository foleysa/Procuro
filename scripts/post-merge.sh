#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter db push

SENTINEL=".local/.environment-initialized"

if [ "${CLEAR_DATA_ON_MERGE:-0}" = "1" ]; then
  echo "[post-merge] CLEAR_DATA_ON_MERGE is set — wiping business data…"
  pnpm --filter @workspace/scripts run clear-data
  mkdir -p "$(dirname "$SENTINEL")"
  touch "$SENTINEL"
elif [ ! -f "$SENTINEL" ]; then
  # No sentinel yet — inspect the DB to distinguish a fresh environment from
  # an existing one that simply pre-dates this sentinel mechanism.
  ORG_COUNT=$(psql "$DATABASE_URL" -At -c "SELECT count(*) FROM orgs;" 2>/dev/null || echo "error")
  if [ "$ORG_COUNT" = "0" ]; then
    echo "[post-merge] first-run detected (no sentinel + empty orgs table) — auto-wiping stale data…"
    pnpm --filter @workspace/scripts run clear-data
  else
    echo "[post-merge] existing environment detected (no sentinel but orgs exist: ${ORG_COUNT}) — skipping auto-wipe"
  fi
  mkdir -p "$(dirname "$SENTINEL")"
  touch "$SENTINEL"
  echo "[post-merge] sentinel written to $SENTINEL — subsequent merges will skip auto-wipe"
fi

# Backfill scope_sku on legacy bls-economic-index rows so the natural-key
# uniqueness index stays consistent across the upgrade. Idempotent: only
# touches rows where scope_sku IS NULL. See script header for context.
pnpm --filter @workspace/scripts run backfill-bls-scope-sku
# Backfill S2P canonical fields on existing opportunities + seed history
# rows. Idempotent: only touches rows where canonical_stage IS NULL and
# only inserts history rows whose opportunity has none. Required so any
# rollout that adds the new S2P columns also populates them on legacy data.
pnpm --filter @workspace/db run backfill-s2p
