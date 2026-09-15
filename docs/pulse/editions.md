# Pulse edition tags

Verticals are **lenses on one desk**. Tags travel on Observe items and
Layer C events. They do not create eight products or eight databases.

## How Pulse editions map to tags

| Pulse packaging | Tags on the issue / event | Status |
|---|---|---|
| **Pulse Core** | `logistics` (core lens; always on) | Horizontal product |
| **Pulse — Industrial MRO Edition** | `mro` | Day 0–30 skin |
| **Pulse — Food & Ag Edition** | `food` | Day 0–30 skin |

Prefer **Core + edition unlocks** over eight tiny newsletters.
Logistics / freight is a **lens inside Core**, not a company identity
and not a third skin to sell as “the product.”

Code: `pulseEditionToTags` / `tagsForPulseEdition()` in `@workspace/pulse`.

## Tag vocabulary (`PulseEditionTag`)

| Tag | Label | Day 0–30 |
|---|---|---|
| `mro` | Industrial MRO | Yes — skin |
| `food` | Food & Ag | Yes — skin |
| `logistics` | Logistics & Freight (core lens) | Core, not a skin |
| `energy` | Energy & Utilities | Reserved name only |
| `aero` | Aerospace / Defense-adjacent | Reserved name only |
| `healthcare` | Healthcare Ops | Reserved name only |
| `packaging` | Packaging & Materials | Reserved name only |
| `discrete` | Discrete Manufacturing / OEM | Reserved name only |

Reserved tags exist so the model stays multi-vertical. **Do not** claim
those editions are live, have depth kits, or have subscriber counts.

## Rules

- An event may carry more than one tag (`food` + `logistics`).
- Do not invent tags like `ocean-freight` or `food-only-pack`.
- Do not treat a tag as a live vertical count on a landing page.
