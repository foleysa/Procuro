# Layer C event taxonomy

Layer C is the labeled **Decide → Learn** corpus. It is the intended
moat: what operators chose, and whether it worked — tagged by vertical
and lever. Public scrapes are Layer A. Opt-in tenant spend is Layer B.

This taxonomy **aligns** with existing OODA tables. It does not replace
`analysis_cycles`, `opportunities`, `decisions`, or `learned_priors`.

## Event (`PulseLayerCEvent`)

Required:

- `schemaVersion`: `1`
- `phase`: `decide` \| `learn`
- `verticalTags`: one or more `PulseEditionTag`
- `occurredAt`: ISO-8601
- `decideAction` when `phase=decide`
- `learnOutcome` when `phase=learn`

Optional / nullable: `leverId` (desk lever), `ownerRole` (role, not
PII), `cycleId`, `opportunityId`, `marketSignalId`,
`tenantLocalStakeUsd` (tenant-local only — never a published Pulse
metric).

`parsePulseLayerCEvent()` is the stub validator.

## Decide actions

| Action | Meaning | Desk hint (not a substitute) |
|---|---|---|
| `renegotiate` | Reopen price / terms | lever `contract_renegotiation_trigger`; sourcing `Negotiated Renewal` / `Should-Cost Challenge` |
| `dual_source` | Add or split source | lever `dual_sourcing`; sourcing `Single-to-Dual Source` |
| `switch_lane` | Change lane / mode | levers `freight_mode_optimization`, `lane_consolidation` |
| `hold` | Wait | `decisions.event_type=snooze` |
| `kill` | Do not pursue | `decisions.event_type=reject` |

`approve` / `execute` / `realize` / `unsnooze` are **lifecycle** events
on `decisions`. They do not auto-fill a Decide action. An operator (or
a later UI) still names renegotiate / dual-source / switch-lane.

`recommended_action` on opportunities stays free text. Layer C is the
closed enum for the corpus.

## Learn outcomes

| Outcome | Meaning |
|---|---|
| `saved` | Outcome beat the baseline (tenant-local). |
| `missed` | Outcome missed the baseline (tenant-local). |
| `unknown` | Not yet known, unused pack, or operator will not guess. **First-class.** |
| `reversed` | A prior Learn was undone. Desk has no event for this yet. |

Mapping rules (honest, conservative):

- `opportunities.status=realized` and `realized_savings_usd > 0` → `saved`
- realized with `0` or negative → `missed`
- realized with a null dollar amount → `unknown`
- proposed / approved / executing / rejected / expired → `unknown`
- Reject and expire **do not** mean missed
- Defense pack `used` ≠ `yes` → `unknown`
- Defense pack used + `deal_lost` → `missed`
- Defense pack used + `supplier_reduced_price` or `supplier_held_price` → `saved` (tenant-local label only)
- No desk path emits `reversed`

Do not publish these labels as Pulse ROI, peer percentiles, or
guaranteed savings.

## Owner roles

`cpo` \| `proc_ops` \| `sc_lead` \| `category_owner` \| `finance` \|
`other`

Role only. No names, emails, or FSA engagement identifiers.

## What this is not

- Not a rewrite of `runAnalysisCycle`
- Not eight vertical warehouses
- Not FSA Weekly Brief events
- Not a license to invent metrics so a Diligence pack “looks live”
