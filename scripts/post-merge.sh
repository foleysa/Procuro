#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter db push
# Backfill scope_sku on legacy bls-economic-index rows so the natural-key
# uniqueness index stays consistent across the upgrade. Idempotent: only
# touches rows where scope_sku IS NULL. See script header for context.
pnpm --filter @workspace/scripts run backfill-bls-scope-sku
# Backfill S2P canonical fields on existing opportunities + seed history
# rows. Idempotent: only touches rows where canonical_stage IS NULL and
# only inserts history rows whose opportunity has none. Required so any
# rollout that adds the new S2P columns also populates them on legacy data.
pnpm --filter @workspace/db run backfill-s2p
