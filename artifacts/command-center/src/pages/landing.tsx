import { Link } from "wouter";
import { Workflow, Sparkles, Activity, TrendingUp } from "lucide-react";

export default function Landing() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/40">
      <div className="max-w-5xl mx-auto px-6 py-16">
        <div className="flex items-center gap-2 text-primary">
          <Workflow className="w-6 h-6" />
          <span className="font-bold text-xl">Procuro</span>
        </div>
        <h1
          data-testid="text-hero"
          className="mt-12 text-5xl font-bold tracking-tight max-w-3xl"
        >
          Procurement‑as‑a‑Service. We don't sell software — we sell savings.
        </h1>
        <p className="mt-6 text-xl text-muted-foreground max-w-3xl">
          We connect to your ERP, learn your spend, and ship cash savings on
          contingency. You only pay a percentage of the savings we realize.
        </p>

        <div className="mt-10 flex gap-4">
          <Link
            href="/"
            data-testid="cta-open-app"
            className="inline-flex items-center gap-2 px-6 py-3 rounded-md bg-primary text-primary-foreground font-medium hover:bg-primary/90"
          >
            Open the Command Center →
          </Link>
        </div>

        <div className="mt-20 grid md:grid-cols-3 gap-6">
          <Card icon={Sparkles} title="OODA loop, not a dashboard">
            Observe spend → Orient with priors → Decide opportunities → Act
            with you in the loop → Learn from every realized outcome.
          </Card>
          <Card icon={Activity} title="Tier‑1 levers, day one">
            SKU benchmark, maverick spend, contract leakage, duplicate payments,
            missed volume tiers, payment terms, tail rationalization — all
            shipped before any AI hand‑waving.
          </Card>
          <Card icon={TrendingUp} title="You only pay on realized savings">
            Default 20% contingency on the dollars we actually move out of
            your P&amp;L. No software seats, no implementation invoices.
          </Card>
        </div>

        <div className="mt-20 border-t pt-10">
          <h2 className="text-2xl font-bold">How a cycle works</h2>
          <ol className="mt-6 space-y-4 max-w-3xl">
            <Step n={1}>
              We pull POs, invoices, contracts, payments, shipments, and raw
              material usage from your ERP via mock or live adapters.
            </Step>
            <Step n={2}>
              The OODA cycle ranks opportunities, applies learned per‑tenant
              priors, and writes them to your queue with rationale and
              recommended action.
            </Step>
            <Step n={3}>
              Your team approves, rejects, or executes. Rejections feed
              structured exclusion rules so the next cycle stops re‑proposing
              what you've already vetoed.
            </Step>
            <Step n={4}>
              Realized savings update the priors. The wheel turns. Generation N
              + 1 is smarter.
            </Step>
          </ol>
        </div>
      </div>
    </div>
  );
}

function Card({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-card border rounded-lg p-6">
      <Icon className="w-8 h-8 text-primary" />
      <h3 className="mt-4 font-semibold">{title}</h3>
      <p className="mt-2 text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-4">
      <span className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/10 text-primary font-bold flex items-center justify-center">
        {n}
      </span>
      <span className="pt-1">{children}</span>
    </li>
  );
}
