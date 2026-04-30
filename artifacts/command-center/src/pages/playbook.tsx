import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LeverId } from "@workspace/api-client-react";
import { leverLabel } from "@/lib/format";
import { BookOpen, CheckCircle2, Clock, Sparkles } from "lucide-react";

type LeverEntry = {
  id: string;
  tier: 1 | 2 | 3 | 4;
  category: string;
  status: "shipped" | "starter" | "planned";
  description: string;
  triggers: string;
  evidence: string;
};

const PLAYBOOK: LeverEntry[] = [
  // Tier 1
  {
    id: LeverId.sku_price_benchmark,
    tier: 1,
    category: "Tactical pricing",
    status: "shipped",
    description: "Find SKUs being purchased above the in‑tenant median price across suppliers.",
    triggers: "Same SKU bought from ≥2 suppliers OR price drift > 8% above category benchmark.",
    evidence: "PO line price vs benchmark; supplier comparison; expected savings = (price − benchmark) × volume.",
  },
  {
    id: LeverId.maverick_spend,
    tier: 1,
    category: "Compliance",
    status: "shipped",
    description: "Spend on suppliers outside an active contract for that category.",
    triggers: "PO posted to non‑contracted supplier when a contract exists.",
    evidence: "Off‑contract PO list; consolidation savings vs contracted unit price.",
  },
  {
    id: LeverId.contract_leakage,
    tier: 1,
    category: "Compliance",
    status: "shipped",
    description: "Invoiced unit price exceeds the contracted price tier.",
    triggers: "Invoice line price > contract_items.unit_price for matching SKU/tier.",
    evidence: "Invoice line vs contract tier; cumulative leakage USD.",
  },
  {
    id: LeverId.duplicate_payment,
    tier: 1,
    category: "Cash recovery",
    status: "shipped",
    description: "Same invoice amount, supplier, period — likely duplicate payment.",
    triggers: "≥2 payments matching (supplier, amount, date ±N days, reference fingerprint).",
    evidence: "Matched payment pairs; recovery candidates.",
  },
  {
    id: LeverId.missed_volume_threshold,
    tier: 1,
    category: "Tactical pricing",
    status: "shipped",
    description: "Spend approaches a contract volume tier that unlocks a lower price.",
    triggers: "Cumulative volume within X% of next contract_items tier.",
    evidence: "Tier breakpoint, current volume, projected savings if next tier reached.",
  },
  {
    id: LeverId.payment_term_extension,
    tier: 1,
    category: "Working capital",
    status: "shipped",
    description: "Suppliers paid faster than necessary; extend terms to free up working capital.",
    triggers: "Avg actual_days_to_pay much shorter than supplier payment_terms_days.",
    evidence: "Supplier‑level WACC × delta‑days × volume.",
  },
  {
    id: LeverId.tail_spend_rationalization,
    tier: 1,
    category: "Sourcing",
    status: "shipped",
    description: "Long tail of low‑volume suppliers in a category.",
    triggers: "Suppliers contributing < 1% of category spend; ≥10 in category.",
    evidence: "Tail supplier list; consolidation savings & process cost reduction.",
  },
  // Tier 2 (starters)
  {
    id: LeverId.supplier_consolidation,
    tier: 2,
    category: "Sourcing",
    status: "starter",
    description: "Consolidate spend with the top 1–2 suppliers in a category for better volume pricing.",
    triggers: "Category with ≥5 suppliers and HHI below threshold.",
    evidence: "Volume to lead supplier; expected price improvement; risk of single‑sourcing.",
  },
  {
    id: LeverId.contract_renegotiation_trigger,
    tier: 2,
    category: "Strategic sourcing",
    status: "starter",
    description: "Contract approaching expiry, expired, or with material price drift since signing.",
    triggers: "Contract end_date < 90 days OR market price drift > 10% since contract.start_date.",
    evidence: "Contract value, time to expiry, observed market index movement.",
  },
  // Tier 3 / 4 — planned
  {
    id: "spot_vs_contract", tier: 3, category: "Strategic sourcing", status: "planned",
    description: "Compare spot purchases vs contract baseline to size renegotiation leverage.",
    triggers: "Spot share rising while contract underutilized.",
    evidence: "Spot vs contract price gap weighted by volume.",
  },
  {
    id: "should_cost_modeling", tier: 3, category: "Direct materials", status: "planned",
    description: "Bottom‑up should‑cost based on raw material indices, labor, and supplier margin.",
    triggers: "Direct materials with traceable input commodities.",
    evidence: "Modeled cost vs paid price; gap = sourcing target.",
  },
  {
    id: "raw_material_hedging", tier: 4, category: "Direct materials", status: "planned",
    description: "Lock raw material exposure when index volatility crosses risk tolerance.",
    triggers: "Index 30‑day vol > tenant threshold and exposure material.",
    evidence: "Hedge ratio, basis risk, expected P&L impact.",
  },
  {
    id: "outcome_based_contract", tier: 4, category: "Indirect / services", status: "planned",
    description: "Convert services SOWs to outcome‑based pricing where measurable KPIs exist.",
    triggers: "Recurring SOWs with clear deliverables and measurable outcomes.",
    evidence: "Historical performance vs outcome target; risk‑adjusted savings.",
  },
];

const STATUS_META: Record<LeverEntry["status"], { label: string; icon: typeof CheckCircle2; cls: string }> = {
  shipped: { label: "Shipped (Tier 1)", icon: CheckCircle2, cls: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300" },
  starter: { label: "Starter (Tier 2)", icon: Sparkles, cls: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300" },
  planned: { label: "Planned", icon: Clock, cls: "bg-muted text-muted-foreground" },
};

export default function Playbook() {
  const tiers = [1, 2, 3, 4] as const;

  return (
    <div className="p-8 space-y-6 max-w-7xl">
      <div>
        <h1 data-testid="text-page-title" className="text-3xl font-bold flex items-center gap-2">
          <BookOpen className="w-7 h-7 text-primary" />
          Procurement Playbook
        </h1>
        <p className="text-muted-foreground mt-1">
          The full lever ladder. Tier 1 ships in this MVP; Tier 2 has starter analyzers; Tier 3–4 are scoped roadmap.
        </p>
      </div>

      {tiers.map((tier) => {
        const items = PLAYBOOK.filter((p) => p.tier === tier);
        if (items.length === 0) return null;
        return (
          <section key={tier} className="space-y-3">
            <h2 className="text-xl font-semibold">Tier {tier}</h2>
            <div className="grid lg:grid-cols-2 gap-4">
              {items.map((p) => {
                const meta = STATUS_META[p.status];
                const Icon = meta.icon;
                return (
                  <Card key={p.id} data-testid={`lever-${p.id}`}>
                    <CardHeader>
                      <div className="flex items-start justify-between gap-3">
                        <CardTitle className="text-base">{leverLabel(p.id)}</CardTitle>
                        <Badge className={meta.cls}>
                          <Icon className="w-3 h-3 mr-1" />
                          {meta.label}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">{p.category}</p>
                    </CardHeader>
                    <CardContent className="text-sm space-y-2">
                      <p>{p.description}</p>
                      <div>
                        <div className="text-xs uppercase tracking-wide text-muted-foreground">Triggers</div>
                        <div>{p.triggers}</div>
                      </div>
                      <div>
                        <div className="text-xs uppercase tracking-wide text-muted-foreground">Evidence</div>
                        <div>{p.evidence}</div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
