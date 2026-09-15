# Pulse Core schema

Horizontal brief. Editions are chapters, not separate products.

## Issue (`PulseCoreIssue`)

| Field | Notes |
|---|---|
| `schemaVersion` | `1` |
| `cadence` | `weekly` \| `twice_monthly` |
| `editionTags` | Day 0–30 skins present in the issue: `mro`, `food` |
| `observe` | Layer A items (public / licensed). See kinds below. |
| `orientQuestions` | Prose questions. Not persisted as desk `orient_payload`. |
| `suggestedDecides` | Optional Layer C **candidates**. Not operator-labeled until Decide. |

Learn outcomes from the desk **do not** appear on an issue until
aggregation rules exist. Never auto-publish tenant Learn into Pulse.

## Observe item

| Field | Notes |
|---|---|
| `kind` | `price_index` \| `disruption_policy` \| `supplier_public` \| `logistics_lane` |
| `verticalTags` | Edition / lens tags (`mro`, `food`, `logistics`, …) |
| `marketSignalType` | Optional. Existing `market_signals.signal_type` |
| `marketSignalId` | Optional. Existing `market_signals.id` |
| `sourceLabel` | Public citation or licensed series name |
| `summary` | What moved. Not a savings claim. |

`observeKindFromMarketSignalType()` maps every current desk signal type
onto a Pulse Observe kind so Pulse Observe stays one spine with the
collectors already in this repo.

## Suggested Decide

| Field | Notes |
|---|---|
| `decideAction` | `renegotiate` \| `dual_source` \| `switch_lane` \| `hold` \| `kill` |
| `verticalTags` | Same tag vocabulary as Layer C |
| `leverId` | Optional. Existing desk `lever_id` |
| `prompt` | Operator language. Not a guaranteed ROI line. |

## Alignment with `analysis_cycles`

| Pulse | Cycle JSONB | Layer |
|---|---|---|
| Observe | `observe_payload` + `market_signals` | A |
| Orient questions | (prose only; desk uses `orient_payload`) | desk |
| Suggested / labeled Decide | `decide_payload` (ranked drafts) + Layer C event | C when labeled |
| Act (out of Pulse issue) | `act_payload` + `decisions.execute` | light |
| Learn (not auto-published) | `learn_payload` + Layer C outcome | C when labeled |

Desk runtime order remains Observe → Learn(previous) → Orient → Decide → Act.
Pulse **product** order is Observe → Orient questions → Decide → Learn.
`@workspace/pulse` records the mapping; it does not change `runAnalysisCycle`.
