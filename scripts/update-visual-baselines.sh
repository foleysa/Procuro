#!/usr/bin/env bash
#
# Regenerate visual regression baselines.
#
# Usage:
#   ./scripts/update-visual-baselines.sh              # update all baselines
#   ./scripts/update-visual-baselines.sh "Dashboard"   # update only tests matching "Dashboard"
#
set -euo pipefail

FILTER="${1:-}"

echo "=== Visual Regression Baseline Update ==="
echo ""

if [ -n "$FILTER" ]; then
  echo "Updating baselines matching: $FILTER"
  pnpm test:visual:update --grep "$FILTER"
else
  echo "Updating ALL baselines"
  pnpm test:visual:update
fi

echo ""
echo "Done. Review the updated PNGs in tests/visual/baselines/ and commit them."
echo "  git add tests/visual/baselines/"
echo "  git commit -m 'chore: update visual baselines'"
