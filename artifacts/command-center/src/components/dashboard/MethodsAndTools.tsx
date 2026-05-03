import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { BookOpen } from "lucide-react";

type Maturity = "Proven" | "Emerging" | "First-Run";

interface MethodEntry {
  sourcingStrategy: string;
  method: string;
  toolSystem: string;
  maturity: Maturity;
}

const METHODS_AND_TOOLS: MethodEntry[] = [
  {
    sourcingStrategy: "Competitive RFP",
    method: "Multi-supplier bid process",
    toolSystem: "Sourcing platform / e-auction",
    maturity: "Proven",
  },
  {
    sourcingStrategy: "Single-to-Dual Source",
    method: "Supply base risk mitigation",
    toolSystem: "Supplier qualification / Spend analytics",
    maturity: "Proven",
  },
  {
    sourcingStrategy: "Should-Cost Challenge",
    method: "Bottom-up cost model vs. supplier quote",
    toolSystem: "Should-cost model / TCO tool",
    maturity: "Emerging",
  },
  {
    sourcingStrategy: "Tiered Pricing Audit",
    method: "Rebate & volume-tier reconciliation",
    toolSystem: "Contract management / Invoice analytics",
    maturity: "Proven",
  },
  {
    sourcingStrategy: "Invoice-to-Contract Reconciliation",
    method: "Automated PO/invoice/contract match",
    toolSystem: "AP automation / Contract analytics",
    maturity: "Proven",
  },
  {
    sourcingStrategy: "Catalog Enforcement",
    method: "Maverick spend channel management",
    toolSystem: "P2P system / Guided buying",
    maturity: "Proven",
  },
  {
    sourcingStrategy: "Negotiated Renewal",
    method: "Pre-expiry renegotiation playbook",
    toolSystem: "CLM / Renewal calendar",
    maturity: "Emerging",
  },
];

function MaturityBadge({ maturity }: { maturity: Maturity }) {
  const styles: Record<Maturity, string> = {
    Proven:
      "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
    Emerging:
      "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
    "First-Run":
      "bg-orange-100 text-orange-800 dark:bg-orange-950/40 dark:text-orange-300",
  };
  return (
    <span
      className={`inline-block text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${styles[maturity]}`}
    >
      {maturity}
    </span>
  );
}

export function MethodsAndTools() {
  return (
    <Card data-testid="methods-and-tools">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <BookOpen className="w-4 h-4 text-muted-foreground" />
          Methods &amp; Tools Registry
        </CardTitle>
        <CardDescription>
          Canonical sourcing strategies mapped to methods, systems, and
          maturity. Reference only — no edit UI yet.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table
            className="w-full text-sm"
            data-testid="table-methods-tools"
          >
            <thead>
              <tr className="text-left text-xs uppercase text-muted-foreground border-b">
                <th className="py-2 pr-3 font-medium">Sourcing Strategy</th>
                <th className="py-2 pr-3 font-medium">Method</th>
                <th className="py-2 pr-3 font-medium">Tool / System</th>
                <th className="py-2 font-medium">Maturity</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {METHODS_AND_TOOLS.map((entry) => (
                <tr
                  key={entry.sourcingStrategy}
                  data-testid={`methods-row-${entry.sourcingStrategy.toLowerCase().replace(/\W+/g, "-")}`}
                >
                  <td className="py-2 pr-3 align-middle font-medium text-xs">
                    {entry.sourcingStrategy}
                  </td>
                  <td className="py-2 pr-3 align-middle text-xs text-muted-foreground">
                    {entry.method}
                  </td>
                  <td className="py-2 pr-3 align-middle text-xs text-muted-foreground">
                    {entry.toolSystem}
                  </td>
                  <td className="py-2 align-middle">
                    <MaturityBadge maturity={entry.maturity} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
