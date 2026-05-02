#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter db push
# Backfill scope_sku on legacy bls-economic-index rows so the natural-key
# uniqueness index stays consistent across the upgrade. Idempotent: only
# touches rows where scope_sku IS NULL. See script header for context.
pnpm --filter @workspace/scripts run backfill-bls-scope-sku
