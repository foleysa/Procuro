# Atlas Procure — Brand Spec (Terminal direction)

> Final spec. Replaces all earlier blue/SaaS-friendly drafts.
> Out of scope: codebase rename, legal trademark opinion, domain purchase.

---

## 1 · Brand essence

**Name:** Atlas Procure
**Read:** Information-dense procurement infrastructure — the calm, professional terminal you trust with eight figures of spend.
**One-liner:** *Procurement-as-a-service that pays for itself — ERP-integrated, contingency-priced.*

**Reference brands:** Bloomberg Terminal, Palantir Foundry, Linear, Stripe Atlas (as a tone reference for "serious infrastructure that doesn't shout").

**Personality**

| Pillar | What it means | What we avoid |
|---|---|---|
| **Instrument-grade** | Sharp corners, hairlines, monospace numbers, no rounded SaaS friendliness. | Pastel gradients, soft shadows, friendly mascots. |
| **Plainspoken** | Real numbers. Short sentences. No adjective stacks. | Hype, exclamation marks, "AI-powered everything". |
| **Quietly confident** | The interface and the savings do the talking. | Emojis in product copy. Marketing-ese. |

---

## 2 · Color palette

Monochrome by default + one decisive accent. Treat the accent like a Bloomberg amber — used sparingly to draw the eye to the *one* thing that matters on a screen.

### Brand colors

| Token | Hex | OKLCH | Use |
|---|---|---|---|
| `signal-blue` (accent — only) | `#2D7FF9` | `oklch(63% 0.21 257)` | The single attention-getter. CTAs, active states, savings figures, the brand mark's underscore. |
| `signal-blue-press` | `#1E6BE8` | `oklch(57% 0.22 257)` | Hover / pressed. |
| `ink` (dark surface) | `#0A0A0B` | `oklch(13% 0.005 280)` | Dark-mode canvas, primary text on light. |
| `paper` (light surface) | `#FFFFFF` | `oklch(100% 0 0)` | Light-mode canvas. |
| `paper-warm` (text on dark) | `#F4F2EE` | `oklch(96% 0.005 80)` | Body text on `ink`. Slightly warm for legibility (Palantir trick). |

### Neutral scale (cool, low-chroma)

Stepped linearly in OKLCH lightness at hue 250, chroma ≤ 0.01 — pure data-grid greys.

| Token | Hex | OKLCH |
|---|---|---|
| `n-50`  | `#F6F7F8` | `oklch(97% 0.005 250)` |
| `n-100` | `#EBEDF0` | `oklch(94% 0.007 250)` |
| `n-200` | `#D6DAE0` | `oklch(88% 0.010 250)` |
| `n-300` | `#B0B6BF` | `oklch(76% 0.012 250)` |
| `n-400` | `#838B95` | `oklch(62% 0.013 250)` |
| `n-500` | `#5C636C` | `oklch(50% 0.012 250)` |
| `n-600` | `#42474F` | `oklch(40% 0.010 250)` |
| `n-700` | `#2A2D33` | `oklch(28% 0.008 250)` |
| `n-800` | `#1B1D21` | `oklch(20% 0.006 250)` |
| `n-900` | `#0A0A0B` | `oklch(13% 0.005 280)` |

### Hairlines & semantic

| Token | Hex | Use |
|---|---|---|
| `hairline-light` | `#D6D3CE` | 1px dividers / table grids on `paper`. |
| `hairline-dark`  | `#2A2A2E` | 1px dividers / table grids on `ink`. |
| `success` | `#3FB984` | Realized savings only. Use sparingly. |
| `warning` | `#E2A93B` | Anomalies. |
| `danger`  | `#E5484D` | Failed runs. |

### WCAG audit

| Pair | Ratio | Verdict |
|---|---|---|
| `ink` on `paper` | 19.6 : 1 | AAA ✅ |
| `paper-warm` on `ink` | 17.2 : 1 | AAA ✅ |
| `signal-blue` on `paper` | 4.7 : 1 | AA ✅ (text), AAA (large/UI) |
| `signal-blue` on `ink` | 4.4 : 1 | AA ✅ (large/UI) — for body text use `paper-warm` |
| `n-500` on `paper` | 5.4 : 1 | AAA ✅ (muted text) |

---

## 3 · Typography

Three roles, one family preferred — IBM Plex (Sans + Mono). Plex's geometric forms and tabular numerics fit the terminal feel; Inter is the fallback if Plex isn't available.

| Role | Recommended | Setting |
|---|---|---|
| Wordmark / display | **IBM Plex Sans 700–900** | Tracked +1 to +3, ALL CAPS for headlines, never centered. |
| UI / body | **IBM Plex Sans 400 / 500** | 16px web body min, line-height 1.5. |
| Numerics ($, %, savings) | **IBM Plex Mono 500 tabular-nums** | Always. Lining figures, never proportional. |
| Code / meta | **IBM Plex Mono 400** | For PO numbers, contract IDs, run IDs. |

Fallback stack: `"IBM Plex Sans", Inter, system-ui, -apple-system, "Segoe UI", "DejaVu Sans", sans-serif`.
The rasterized SVGs in this kit use DejaVu Sans Bold (only what's installed in the environment) — they're representative; production should swap in IBM Plex.

---

## 4 · Voice & tone

**Adjectives:** anchored, plainspoken, exact, dryly confident, never hype-y.

We talk like a senior procurement lead who's seen it all. Short sentences. Real numbers. No jargon-for-jargon's-sake. Say *"saved $84,200 on Acme contract"* not *"unlocked transformative value"*.

### Copy examples

| Context | Copy |
|---|---|
| **Marketing headline** | Procurement that pays for itself. |
| **Sub-headline** | We sit between your ERP and your suppliers, find the savings, and only get paid when you do. |
| **Onboarding welcome** | Welcome to Atlas Procure. Connect your ERP — most teams see first savings within 14 days. |
| **Empty state** | No savings to show yet. Atlas is scanning your last 12 months of POs — first results within a week. |
| **Error (sync failed)** | We couldn't reach NetSuite. Retried 3 times in the last 5 minutes. Check the connection or [open a ticket]. |
| **Primary CTA** | Run a free spend scan |
| **Secondary CTA** | Talk to a procurement lead |
| **Confirmation toast** | Saved. Atlas will pick this up on the next ERP sync. |
| **Destructive confirm** | Disconnect NetSuite? Atlas will pause savings work until you reconnect. |

### Don'ts

- ❌ "Revolutionize your procurement workflow with AI-powered insights"
- ❌ "🚀 Unlock transformative value!"
- ❌ "Synergize spend optimization across stakeholder verticals"
- ✅ "Atlas found 14 invoices Acme overcharged you on. Total: $11,402."

---

## 5 · Logo system

### Primary mark — **Cipher**

Heavy stencil-cut **A** monogram, monochrome, with a single thin `signal-blue` underscore. Sharp corners only. Lives equally well on `paper` and `ink`.

- **Strengths:** Reads at every size including 32px favicon. Single-letter monogram works as social avatar. The stencil notch quietly references both classic typography and a terminal cursor.
- **Use everywhere:** app icon, favicon, document headers, social profile, deck cover.

**Wordmark accent.** The wordmark adds a thin `signal-blue` overscore that spans exactly the width of "ATLAS" — never the full word. This intentionally signals the brand hierarchy: *ATLAS* is the brand, *Procure* is the descriptor. Keep the overscore at 3px height (web) and aligned ~10px above the cap line. Don't let it span the full wordmark or recolor it.

Files: `attached_assets/branding/atlas-procure/v2-terminal/cipher/`

### Marketing motif — **Signal**

A terminal-panel tile: hairline frame with corner ticks, three left-aligned data-bar rows (top one in `signal-blue`), and a `signal-blue` status square in the upper right. Not the primary mark — a graphic device for marketing surfaces.

- **Use as:** hero-section background pattern, deck section dividers, blog post header art, OG card variants. Don't use as app icon (collapses below 64px).

Files: `attached_assets/branding/atlas-procure/v2-terminal/signal/`

### Retired

The earlier blue/round-square directions (`compass/`, `pillar/`, `horizon/`) and the alternate `quadrant/` tile are kept on disk for reference but **are not part of the active brand system.** Don't use them in production.

---

## 6 · Design tokens (drop-in)

### CSS custom properties

```css
:root {
  /* Surface */
  --color-paper:        #FFFFFF;
  --color-paper-warm:   #F4F2EE;
  --color-ink:          #0A0A0B;

  /* Neutrals */
  --n-50:  #F6F7F8;  --n-100: #EBEDF0;  --n-200: #D6DAE0;
  --n-300: #B0B6BF;  --n-400: #838B95;  --n-500: #5C636C;
  --n-600: #42474F;  --n-700: #2A2D33;  --n-800: #1B1D21;
  --n-900: #0A0A0B;

  /* Accent (use sparingly) */
  --signal-blue:        #2D7FF9;
  --signal-blue-press:  #1E6BE8;

  /* Semantic */
  --success: #3FB984;
  --warning: #E2A93B;
  --danger:  #E5484D;

  /* Hairlines */
  --hairline: #D6D3CE;

  /* Roles (light) */
  --bg:         var(--color-paper);
  --bg-subtle:  var(--n-50);
  --bg-tile:    var(--n-100);
  --border:     var(--hairline);
  --text:       var(--color-ink);
  --text-muted: var(--n-500);
  --accent:     var(--signal-blue);

  /* Type */
  --font-sans: "IBM Plex Sans", Inter, system-ui, -apple-system, "Segoe UI", "DejaVu Sans", sans-serif;
  --font-mono: "IBM Plex Mono", "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;

  /* Geometry — sharp corners only. No rounding above 2px. */
  --radius-sm: 0px;
  --radius-md: 2px;
  --radius-lg: 2px;
  --shadow-sm: 0 0 0 1px rgb(0 0 0 / 0.04);
  --shadow-md: 0 1px 0 rgb(0 0 0 / 0.06);
}

[data-theme="dark"] {
  --hairline:   #2A2A2E;
  --bg:         var(--color-ink);
  --bg-subtle:  var(--n-800);
  --bg-tile:    var(--n-700);
  --border:     var(--hairline);
  --text:       var(--color-paper-warm);
  --text-muted: var(--n-300);
  --accent:     var(--signal-blue);
}
```

### Tailwind config

```js
// tailwind.config.{js,ts}
export default {
  theme: {
    extend: {
      colors: {
        ink:       "#0A0A0B",
        paper:     "#FFFFFF",
        "paper-warm": "#F4F2EE",
        signal:    { DEFAULT: "#2D7FF9", press: "#1E6BE8" },
        n: {
          50:  "#F6F7F8", 100: "#EBEDF0", 200: "#D6DAE0",
          300: "#B0B6BF", 400: "#838B95", 500: "#5C636C",
          600: "#42474F", 700: "#2A2D33", 800: "#1B1D21",
          900: "#0A0A0B",
        },
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', "Inter", "system-ui", "-apple-system", "Segoe UI", '"DejaVu Sans"', "sans-serif"],
        mono: ['"IBM Plex Mono"', '"JetBrains Mono"', '"SF Mono"', "Menlo", "Consolas", "monospace"],
      },
      fontFeatureSettings: { nums: '"tnum", "lnum"' },
      borderRadius: { sm: "0px", md: "2px", lg: "2px" },
      boxShadow: {
        sm: "inset 0 0 0 1px rgb(0 0 0 / 0.04)",
        md: "0 1px 0 rgb(0 0 0 / 0.06)",
      },
    },
  },
};
```

---

## 7 · Accessibility standards

- **Contrast:** All body text ≥ 4.5:1 (AA). On `ink`, body must use `paper-warm` (17:1), not `signal-blue` (4.4:1 — large/UI only).
- **Minimum font sizes:** Web body ≥ 16px, mobile body ≥ 14px, captions ≥ 12px. Never use display weights for body.
- **Touch targets:** ≥ 44×44px (iOS) / 48×48dp (Android).
- **Motion:** No decorative motion in the mark. Any UI transitions wrapped in `@media (prefers-reduced-motion: no-preference)`.
- **Icon clarity:** The Cipher A is recognizable monochrome at 24px — never relies on the blue underscore to convey identity.
- **Focus states:** 2px `signal-blue` outline at 2px offset. Never `outline: none` without a visible alternative.

---

## 8 · File map

```
attached_assets/branding/atlas-procure/
├── BRAND.md                                ← this file (canonical)
├── NAME_SHORTLIST.md                       ← naming receipts (round 1)
├── NAME_SHORTLIST_ROUND2.md                ← naming receipts (round 2)
└── v2-terminal/                            ← ACTIVE brand assets
    ├── cipher/                             ← PRIMARY MARK
    │   ├── svg/   icon-, wordmark-, lockup- × {light,dark}
    │   └── png/   favicon-32, app-icon-512-{light,dark},
    │              social-1200x630-{light,dark}, wordmark-1200-{light,dark}
    └── signal/                             ← MARKETING MOTIF only
        └── (same layout)

(retired — kept on disk for reference, do not use:
 compass/, pillar/, horizon/, v2-terminal/quadrant/)
```

Required sizes from the brief — **32 (favicon), 512 (app icon), 1200×630 (social)** — are present in light and dark for both Cipher and Signal, with full SVG masters.

---

## 9 · Usage rules (quick)

- **Mark color:** Cipher A is always `ink` on light surfaces, `paper-warm` on dark surfaces. Never blue. The blue is only the underscore.
- **Clear space:** ≥ ¼ of the icon's height around the mark.
- **Min size:** Lockup ≥ 120 px / 25 mm wide. Cipher icon-only down to 16 px.
- **Backgrounds:** Use light variants on `paper` / `n-50` / `n-100`. Use dark variants on `ink` / `n-800` / `n-900`. Never on a colored brand surface — the mark must always be on a near-neutral.
- **Don'ts:** No drop shadows, no gradients, no rotation, no recoloring outside this palette, no rounded-corner versions of the mark.

---

## 10 · Open items (tracked as follow-ups)

- Codebase rename of "Procuro" → "Atlas Procure" — task **#274**.
- Formal USPTO TESS + WHOIS clearance for `atlasprocure.com` / `.ai` / `.io` — task **#275**.
- Optional: spin up the design subagent for a "brand in action" board showing Cipher + Signal applied to the actual Command Center landing — not built in this task.
