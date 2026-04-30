# Composite risk scoring

This document describes the v1 composite scoring used by the Fusion
Center Heatmap and Entity 360 risk panel. The implementation lives at
`lib/intelligence/src/scoring/composite.ts` — keep this file in sync
when you change the formula.

## Goals

1. **Transparent.** Every score is a weighted sum of the contributing
   signals; we never hide it behind an opaque ML model. The UI can
   always render the contributors.
2. **Auditable.** `scoreDimension()` returns `topContributors` so the
   "why" affordance can show the source rows with their disclosure
   tier badges.
3. **Tenant-scoped.** The scorer is pure — callers are responsible for
   filtering signals to the active tenant *and* the active disclosure
   policy before invoking it. Nothing in the scorer escapes the tenant
   boundary.

## Inputs

The scorer takes a flat array of `ScoringSignal` records. Each carries:

- `signalType` — concrete `marketSignalTypes` value.
- `tier` — disclosure tier inherited from the contributing collector
  contract (`T1`–`T4`).
- `confidence` — `[0,1]`; defaults to `0.7` if missing (matches the DB
  default on `market_signals.confidence`).
- `value` — raw signal magnitude on the upstream source's own scale.
- `observedAt` — wall-clock observation time.

## Formula

For each dimension `d` and each signal `s` whose `signalType` has a
weight in `SIGNAL_WEIGHTS[d]`:

```
norm     = SIGNAL_TYPE_NORMALISERS[s.signalType](s.value)   # [0,1]
decay    = 0.5 ** (age_days / HALF_LIFE_DAYS[d])             # [0,1]
weighted = norm * SIGNAL_WEIGHTS[d][s.signalType]
                 * decay
                 * confidence
                 * TIER_MULTIPLIER[s.tier]
```

T4 contributions accumulate separately and are capped at
`T4_MAX_DELTA = 15%` of the non-T4 aggregate so a never-disclosed feed
cannot drive a score on its own.

The raw aggregate is mapped to the `0..100` UI band with a saturating
curve:

```
score = round(100 * (1 - exp(-rawAggregate / 2.5)))
```

The `2.5` anchor was chosen so ~3 strong contributions saturate to the
high-90s. Lowering it makes the heatmap hotter overall; raising it
makes it cooler.

## Half-lives

| Dimension  | Half-life |
| ---------- | --------- |
| geo        | 14 d      |
| financial  | 90 d      |
| cyber      | 30 d      |
| esg        | 180 d     |
| climate    | 365 d     |
| sanctions  | 730 d     |

These reflect how quickly each kind of risk decays in the real world:
geo events go stale within a fortnight; sanctions persist for years.

## Tier multipliers

| Tier | Multiplier |
| ---- | ---------- |
| T1   | 1.00       |
| T2   | 0.90       |
| T3   | 0.75       |
| T4   | 0.60       |

We further cap the *aggregate* T4 contribution per dimension at 15%
of the non-T4 aggregate.

## Adding a new signal type

1. Decide which dimension(s) it belongs to and its peak weight in
   `SIGNAL_WEIGHTS`.
2. Add a `SIGNAL_TYPE_NORMALISERS` entry that projects the raw value
   into `[0,1]`. If you skip this, it falls back to a generic
   `|x|/10` clamp.
3. Document the choice in this file.

## Out of scope for v1

- Dimension cross-correlations (e.g. a sanctions hit raising the
  financial score). v1 keeps dimensions independent.
- Geographic spread / "concentration" scores; v1 just composites the
  signals attached to each entity or scope.
- Backtesting / calibration. The weights above are reasoned defaults
  to be tuned once we have realised-incident outcomes to compare
  against.
