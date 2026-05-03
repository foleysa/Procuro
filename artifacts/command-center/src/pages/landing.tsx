import { Link } from "wouter";
import {
  Workflow,
  HandCoins,
  Plug,
  Repeat,
  ArrowRight,
} from "lucide-react";

// Primary CTA target. We don't have a booking tool wired up yet, so
// "Book a pilot" opens an email draft to the pilots inbox. Swap to a
// scheduling link when one exists.
const PILOT_MAILTO =
  "mailto:pilots@atlasprocure.com?subject=Atlas%20Procure%20pilot%20interest";

export default function Landing() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/40">
      <div className="max-w-6xl mx-auto px-6 py-12 md:py-16">
        {/* Brand bar.
          * TODO: swap in the official Atlas Procure logo asset once
          * Task #274 ships it. Until then we render the icon + a clean
          * text wordmark using the app's display font, per the task
          * spec's placeholder guidance. */}
        <div
          className="flex items-center gap-2 text-primary"
          data-testid="brand-wordmark"
        >
          <Workflow className="w-7 h-7" />
          <span className="font-bold text-xl tracking-tight text-foreground">
            Atlas <span className="text-primary">Procure</span>
          </span>
        </div>

        {/* Hero */}
        <section className="mt-14 md:mt-20 max-w-4xl">
          <div className="inline-flex items-center gap-2 rounded-full border bg-card px-3 py-1 text-xs font-medium text-muted-foreground">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-primary" />
            Procurement‑as‑a‑Service for mid‑market manufacturers &amp;
            distributors
          </div>
          <h1
            data-testid="text-hero"
            className="mt-6 text-4xl md:text-6xl font-bold tracking-tight leading-[1.05]"
          >
            We don&rsquo;t sell software.
            <br className="hidden md:block" />{" "}
            <span className="text-primary">We ship cash savings.</span>
          </h1>
          <p className="mt-6 text-lg md:text-xl text-muted-foreground max-w-2xl">
            Atlas Procure plugs into your ERP, finds the dollars hiding in
            your spend, and works the levers with your team. You pay a
            percentage of what we put back on your P&amp;L &mdash; nothing
            up front, no seats, no implementation invoice.
          </p>

          <div className="mt-10 flex flex-col sm:flex-row gap-3">
            <a
              href={PILOT_MAILTO}
              data-testid="cta-book-pilot"
              className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-md bg-primary text-primary-foreground font-medium hover:bg-primary/90 transition-colors"
            >
              Book a pilot
              <ArrowRight className="w-4 h-4" />
            </a>
            <Link
              href="/"
              data-testid="cta-open-app"
              className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-md border bg-card text-foreground font-medium hover:bg-muted transition-colors"
            >
              Open the Command Center
            </Link>
          </div>
        </section>

        {/* Credibility strip */}
        <section
          aria-label="Positioning"
          className="mt-16 md:mt-20 rounded-xl border bg-card px-6 py-6 md:py-5"
        >
          <div className="grid gap-6 md:grid-cols-[1.4fr_1fr_1fr_1fr] md:items-center">
            <p className="text-sm md:text-base text-muted-foreground">
              Built for mid‑market manufacturers and distributors with{" "}
              <span className="text-foreground font-medium">$25M–$500M</span>{" "}
              in addressable spend.
            </p>
            <Stat label="Live in" value="≤ 2 weeks" />
            <Stat label="Typical run‑rate impact" value="3–7%" />
            <Stat label="You pay only on" value="realized $" />
          </div>
        </section>

        {/* Value props */}
        <section className="mt-16 md:mt-24">
          <h2 className="text-3xl font-bold tracking-tight">
            Three things that make this different
          </h2>
          <div className="mt-8 grid md:grid-cols-3 gap-5">
            <Card
              icon={HandCoins}
              title="Contingency pricing"
              detail="Default 20% of realized savings"
            >
              We only get paid on the dollars we actually move out of your
              P&amp;L &mdash; verified against your GL. No software seats.
              No SOW for the privilege of looking at your data.
            </Card>
            <Card
              icon={Plug}
              title="ERP‑native onboarding"
              detail="Live in 2 weeks, not 2 quarters"
            >
              We pull POs, invoices, contracts, and payments straight from
              NetSuite, SAP, Dynamics, or a flat‑file drop. No new system
              for your team to learn, no rip‑and‑replace.
            </Card>
            <Card
              icon={Repeat}
              title="Learning loop"
              detail="Every cycle gets sharper"
            >
              Each opportunity we ship &mdash; or you reject &mdash; trains
              the next cycle. Tail spend, contract leakage, duplicate
              payments, missed volume tiers: the model learns your business,
              not a generic benchmark.
            </Card>
          </div>
        </section>

        {/* How a cycle works */}
        <section className="mt-16 md:mt-24 border-t pt-12 md:pt-16">
          <h2 className="text-3xl font-bold tracking-tight">
            How a cycle works
          </h2>
          <p className="mt-3 text-muted-foreground max-w-2xl">
            Four steps, repeated. Most clients see the first realized
            savings inside the first cycle.
          </p>
          <ol className="mt-10 grid gap-6 md:grid-cols-2 max-w-4xl">
            <Step n={1} title="Connect">
              We connect to your ERP and a few adjacent systems. Within
              days we&rsquo;re reading the same POs, invoices, contracts,
              and payments your AP team sees.
            </Step>
            <Step n={2} title="Surface">
              The engine ranks the opportunities worth your attention &mdash;
              overpaid SKUs, off‑contract spend, duplicate invoices, missed
              rebates &mdash; each with a dollar estimate and the action to
              take.
            </Step>
            <Step n={3} title="Act">
              Your team approves, rejects, or asks us to execute. We
              negotiate, recover, and re‑route on your behalf, in your
              name, with you in the loop.
            </Step>
            <Step n={4} title="Learn">
              Realized savings get verified against your GL and feed back
              into the next cycle. What you&rsquo;ve already vetoed
              doesn&rsquo;t come back. What worked, scales.
            </Step>
          </ol>
        </section>

        {/* Closing CTA */}
        <section className="mt-20 md:mt-28 rounded-2xl border bg-card p-8 md:p-12 text-center">
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight">
            Ready to see what&rsquo;s in your spend?
          </h2>
          <p className="mt-3 text-muted-foreground max-w-xl mx-auto">
            A pilot takes about two weeks to stand up and runs on
            contingency. If we don&rsquo;t find savings, you don&rsquo;t pay.
          </p>
          <div className="mt-6 flex flex-col sm:flex-row gap-3 justify-center">
            <a
              href={PILOT_MAILTO}
              data-testid="cta-book-pilot-bottom"
              className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-md bg-primary text-primary-foreground font-medium hover:bg-primary/90 transition-colors"
            >
              Book a pilot
              <ArrowRight className="w-4 h-4" />
            </a>
            <Link
              href="/"
              className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-md border bg-background text-foreground font-medium hover:bg-muted transition-colors"
            >
              Open the Command Center
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
    </div>
  );
}

function Card({
  icon: Icon,
  title,
  detail,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  detail: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-card border rounded-xl p-6 flex flex-col">
      <div className="w-10 h-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
        <Icon className="w-5 h-5" />
      </div>
      <h3 className="mt-4 font-semibold text-lg">{title}</h3>
      <div className="mt-1 text-xs font-medium uppercase tracking-wide text-primary">
        {detail}
      </div>
      <p className="mt-3 text-sm text-muted-foreground leading-relaxed">
        {children}
      </p>
    </div>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-4">
      <span className="flex-shrink-0 w-9 h-9 rounded-full bg-primary/10 text-primary font-bold flex items-center justify-center">
        {n}
      </span>
      <div>
        <div className="font-semibold">{title}</div>
        <p className="mt-1 text-sm text-muted-foreground leading-relaxed">
          {children}
        </p>
      </div>
    </li>
  );
}
