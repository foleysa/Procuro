import type { PulseCoreIssue } from "../align";

/**
 * Pulse Core v0 stub — week of 15 Sep 2026.
 * Public / licensed-public citations only. No tenant $ , no FSA files,
 * no peer percentiles, no Pulse subscriber or savings claims.
 */
export const pulseCoreIssue20260916 = {
  schemaVersion: 1,
  id: "pulse-2026-09-16",
  title: "Pulse Core — week of 15 Sep 2026",
  publishedOn: "2026-09-16",
  cadence: "weekly",
  editionTags: ["mro", "food"],
  observe: [
    {
      kind: "logistics_lane",
      verticalTags: ["logistics"],
      marketSignalType: "freight_rate",
      sourceLabel: "BLS PPI — truck transportation of freight (Aug 2026)",
      sourceUrl: "https://www.bls.gov/news.release/archives/ppi_09102026.htm",
      summary:
        "BLS (released 10 Sep 2026): final-demand truck transportation of freight rose 2.0% in August, reversing July’s 1.8% decline. FRED series WPU3012 printed 177.458 in August vs 173.943 in July (index Jun 2009=100, NSA).",
    },
    {
      kind: "logistics_lane",
      verticalTags: ["logistics"],
      marketSignalType: "freight_rate",
      sourceLabel: "Cass Freight Index — August 2026",
      sourceUrl:
        "https://www.cassinfo.com/freight-audit-payment/cass-transportation-indexes/august-2026",
      summary:
        "Cass (released 14 Sep 2026): shipments 1.038, +2.1% y/y (first annual gain since Jan 2023, ending a 42-month downturn) and +5.6% m/m. Expenditures 3.722, +18.7% y/y. Truckload linehaul index 153.9, +11.3% y/y. Cass’s own note: this roughly offsets recent declines — they hesitate to call it a major demand improvement.",
    },
    {
      kind: "price_index",
      verticalTags: ["mro"],
      marketSignalType: "commodity_index",
      sourceLabel:
        "BLS / FRED — machinery & equipment wholesaling (PCU42380042380011)",
      sourceUrl: "https://fred.stlouisfed.org/series/PCU42380042380011",
      summary:
        "August 2026 index 157.064 vs July 157.988 (May 2019=100, NSA). BLS narrative: machinery and equipment wholesaling moved lower in August while truck freight led the services increase. MRO buyers: parts paper and inbound freight are not moving together.",
    },
    {
      kind: "price_index",
      verticalTags: ["mro"],
      marketSignalType: "commodity_index",
      sourceLabel:
        "BLS / FRED — metal & mineral merchant wholesalers (PCU42354235)",
      sourceUrl: "https://alfred.stlouisfed.org/series?seid=PCU42354235",
      summary:
        "August 2026 index 188.939 vs July 188.152 and June 175.689 (May 2019=100, NSA). The June→July step is the move that still needs an index-lag conversation; August was a small follow-through. BLS also reported iron and steel scrap down in August after nonferrous scrap rose 3.7%.",
    },
    {
      kind: "price_index",
      verticalTags: ["food"],
      marketSignalType: "economic_index",
      sourceLabel: "USDA ERS Food Price Outlook — August 2026",
      sourceUrl:
        "https://www.ers.usda.gov/data-products/food-price-outlook/summary-findings",
      summary:
        "August 2026 outlook (uses July CPI/PPI; next ERS update 25 Sep 2026): 2026 all-food forecast +3.0% (interval 2.4–3.5). Food-at-home +2.5% (1.7–3.3). Food-away-from-home +3.6% (3.2–3.9). Farm-level prices forecast +17.1% for 2026 (wide interval). Eggs and fats/oils forecast lower vs 2025; beef, seafood, fresh produce, sugar, and nonalcoholic beverages forecast faster than their 20-year averages.",
    },
    {
      kind: "disruption_policy",
      verticalTags: ["food"],
      marketSignalType: "entity_news_event",
      sourceLabel: "FDA — Salmonella Bovismorbificans / broccoli sprouts (Sep 2026)",
      sourceUrl:
        "https://www.fda.gov/food/outbreaks-foodborne-illness/outbreak-investigation-salmonella-sprouts-september-2026",
      summary:
        "FDA/CDC (ongoing): 22 illnesses, 2 hospitalizations, 0 deaths; last onset 26 Aug 2026. Recalled Evergreen Fresh Sprouts broccoli sprouts (use-by 7/9/11/14/16 Sep 2026). Confirmed distribution ID, MT, WA — product may have moved further. Separate from the alfalfa-sprout investigation. Retail, foodservice, and ingredient buyers: do not eat, serve, or sell recalled lots.",
    },
    {
      kind: "disruption_policy",
      verticalTags: ["food"],
      marketSignalType: "entity_news_event",
      sourceLabel:
        "FDA — E. coli O145:H28 frozen blueberries / berry blend (updated Sep 2026)",
      sourceUrl:
        "https://www.fda.gov/food/outbreaks-foodborne-illness/outbreak-investigation-e-coli-o145h28-frozen-blueberries-july-2026",
      summary:
        "FDA updated 3 Sep 2026: investigation ongoing for organic frozen blueberries from Frutas y Hortalizas del Sur S.A. (Chile). Great Value Organic Triple Berry Blend 10 oz lot 6040 01-6 added to the recall (shipped to select Walmart stores in 16 states). Earlier GreenWise lots remain on the Publix stop-sale. Freezer residual risk, not a shelf-life problem.",
    },
  ],
  orientQuestions: [
    "Is the August truck-freight PPI bounce (+2.0%) a one-month snap-back from July (−1.8%), or is it the same capacity story Cass is printing in linehaul (+11.3% y/y)?",
    "Where do open MRO contracts still reprice off a pre-July metals-wholesale print, and which sites can dual-source bearings / PVF / electrical if lead times stretch?",
    "Which food plants still take sprout or frozen-berry ingredients — and is the hold a SKU kill or a supplier-lot quarantine?",
    "If ERS farm-level prices are the 2026 pressure (forecast +17.1%, wide band) while food-at-home is only +2.5%, who is eating the spread: grower, processor, or retailer chargebacks?",
    "What would we need to see in the 25 Sep ERS update or the 15 Oct PPI to flip hold → renegotiate on freight and metals?",
  ],
  suggestedDecides: [
    {
      decideAction: "hold",
      verticalTags: ["logistics"],
      leverId: "spot_vs_contract",
      prompt:
        "Hold new mode/lane switches for one cycle. August PPI and Cass both moved; Cass explicitly declines to call demand repaired. Revisit after the next PPI (scheduled 15 Oct 2026) unless a lane is already failing service.",
    },
    {
      decideAction: "renegotiate",
      verticalTags: ["logistics"],
      leverId: "contract_renegotiation_trigger",
      prompt:
        "Where linehaul or fuel language still assumes 2025 prints, open a fact-based review citing BLS truck freight (Aug +2.0%) and Cass TL linehaul (+11.3% y/y). No savings number until Learn is labeled.",
    },
    {
      decideAction: "renegotiate",
      verticalTags: ["mro"],
      leverId: "index_based_pricing",
      prompt:
        "Pull MRO / metals contracts with index lags against PCU42354235 (June 175.689 → July 188.152 → August 188.939). Ask whether the June–July step has already been billed. Do not book a win until the invoice lands.",
    },
    {
      decideAction: "dual_source",
      verticalTags: ["mro"],
      leverId: "dual_sourcing",
      prompt:
        "For single-source bearings, PVF, or electrical SKUs that also ride truckload inbound: start a dual-source file now. Freight and metals are moving on different clocks; line-down risk is the reason, not a savings claim.",
    },
    {
      decideAction: "kill",
      verticalTags: ["food"],
      prompt:
        "Kill / quarantine recalled broccoli-sprout lots (Evergreen Fresh Sprouts use-by dates above). This is a food-safety Decide, not a cost play. Log Learn as unknown until substitution cost is known.",
    },
    {
      decideAction: "hold",
      verticalTags: ["food"],
      prompt:
        "Hold new frozen-berry awards until lot codes are checked against the 3 Sep FDA update. Freezer residual — do not assume the July advisory is stale.",
    },
    {
      decideAction: "renegotiate",
      verticalTags: ["food"],
      leverId: "contract_renegotiation_trigger",
      prompt:
        "On ingredients ERS flags above their 20-year average (beef, seafood, fresh produce, sugar), ask whether 2026 paper still uses a 2025 farm-price baseline. ERS farm-level forecast is +17.1% with a wide interval — treat the interval as unknown, not a target.",
    },
  ],
} as const satisfies PulseCoreIssue;
