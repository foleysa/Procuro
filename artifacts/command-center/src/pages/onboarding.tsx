import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetOnboardingState,
  usePatchOnboardingState,
  useGetReadiness,
  useInstallSampleData,
  useRemoveSampleData,
  useRunNextCycle,
  useListCycles,
  getGetReadinessQueryKey,
  getGetOnboardingStateQueryKey,
  getListCyclesQueryKey,
  type OnboardingWizardStep,
  type OnboardingState,
  type ReadinessResponse,
  type Cycle,
} from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { useMyRole } from "@/lib/use-my-role";
import {
  ArrowRight,
  CheckCircle2,
  CircleDashed,
  Database,
  FlaskConical,
  Loader2,
  Play,
  Settings as SettingsIcon,
  Sparkles,
  Tags,
  Trash2,
  UploadCloud,
  Users,
} from "lucide-react";

interface StepDef {
  key: OnboardingWizardStep;
  title: string;
  blurb: string;
  icon: React.ComponentType<{ className?: string }>;
}

const STEPS: StepDef[] = [
  {
    key: "welcome",
    title: "Welcome to Atlas Procure",
    blurb:
      "We'll wire up your data, map your categories, invite the team, set policy and run your first analysis cycle.",
    icon: Sparkles,
  },
  {
    key: "bring_data",
    title: "Bring your data",
    blurb:
      "Connect an ERP integration, upload CSVs, or load the curated sample dataset to preview the platform end-to-end.",
    icon: Database,
  },
  {
    key: "map_categories",
    title: "Map your categories",
    blurb:
      "Confirm category codes and ownership so spend rolls up the way your team thinks about it.",
    icon: Tags,
  },
  {
    key: "invite_team",
    title: "Invite your team",
    blurb:
      "Add buyers, approvers and analysts so the right people see the right opportunities.",
    icon: Users,
  },
  {
    key: "configure_settings",
    title: "Configure billing & policy",
    blurb:
      "Set the success-fee, contract renewal alert window, and your insight disclosure policy.",
    icon: SettingsIcon,
  },
  {
    key: "run_first_cycle",
    title: "Run your first cycle",
    blurb:
      "Kick off the OODA loop. Atlas Procure will analyse your data and propose savings opportunities.",
    icon: Play,
  },
];

export default function OnboardingPage() {
  const qc = useQueryClient();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { isOrgAdmin } = useMyRole();
  const stateQ = useGetOnboardingState();
  const readinessQ = useGetReadiness();
  const patchM = usePatchOnboardingState({
    mutation: {
      onSuccess: () =>
        qc.invalidateQueries({ queryKey: getGetOnboardingStateQueryKey() }),
    },
  });

  const state = stateQ.data;
  const readiness = readinessQ.data;
  const isLoading = stateQ.isLoading || readinessQ.isLoading;

  const completedKeys = useMemo(
    () => new Set((state?.completedSteps ?? []).map((c) => c.step)),
    [state],
  );

  // Allow navigation only forward from the highest-completed step + 1, but
  // also allow jumping back to any prior step. Default to the persisted
  // currentStep when the actor lands on the page fresh.
  const [activeStep, setActiveStep] = useState<OnboardingWizardStep | null>(
    null,
  );
  const effective = activeStep ?? (state?.currentStep ?? "welcome");
  const stepIndex = STEPS.findIndex((s) => s.key === effective);
  const totalSteps = STEPS.length;

  function jumpTo(step: OnboardingWizardStep) {
    setActiveStep(step);
    patchM.mutate({ data: { currentStep: step } });
  }

  function markComplete(step: OnboardingWizardStep) {
    patchM.mutate({ data: { completedStep: step } });
  }

  function advance() {
    const cur = STEPS[stepIndex];
    if (!cur) return;
    markComplete(cur.key);
    const nextStep = STEPS[stepIndex + 1];
    if (nextStep) {
      jumpTo(nextStep.key);
    } else {
      patchM.mutate(
        { data: { completed: true } },
        {
          onSuccess: () =>
            toast({
              title: "Setup complete",
              description: "Atlas Procure is ready — happy hunting!",
            }),
        },
      );
    }
  }

  function dismiss() {
    patchM.mutate(
      { data: { dismissed: true } },
      {
        onSuccess: () => {
          toast({
            title: "Wizard dismissed",
            description: "You can re-open it from the dashboard at any time.",
          });
          setLocation("/");
        },
      },
    );
  }

  if (isLoading) {
    return (
      <div className="p-12 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading setup&hellip;
      </div>
    );
  }
  if (!state) {
    return (
      <div className="p-12 text-sm text-muted-foreground">
        Could not load onboarding state.
      </div>
    );
  }

  const completedCount = STEPS.filter((s) => completedKeys.has(s.key)).length;
  const completedPct = Math.round((completedCount / totalSteps) * 100);
  const StepIcon = STEPS[stepIndex]?.icon ?? Sparkles;

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6" data-testid="onboarding-page">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Get Atlas Procure ready
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Six quick steps will turn your data into an active OODA loop.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {state.completed ? (
            <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200">
              Setup complete
            </Badge>
          ) : null}
          <Button variant="ghost" size="sm" onClick={dismiss}>
            Skip for now
          </Button>
        </div>
      </header>

      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">
              Step {stepIndex + 1} of {totalSteps}
            </span>
            <span className="text-muted-foreground">
              {completedCount} completed · {completedPct}%
            </span>
          </div>
          <Progress value={completedPct} className="h-2" />
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 pt-2">
            {STEPS.map((s, idx) => {
              const done = completedKeys.has(s.key);
              const active = s.key === effective;
              const Icon = s.icon;
              return (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => jumpTo(s.key)}
                  className={`text-left rounded-md border px-3 py-2 text-xs transition-colors ${
                    active
                      ? "border-primary bg-primary/5 text-primary"
                      : done
                        ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                        : "border-slate-200 hover:border-slate-300"
                  }`}
                  data-testid={`step-pill-${s.key}`}
                >
                  <span className="flex items-center gap-1.5">
                    {done ? (
                      <CheckCircle2 className="h-3 w-3" />
                    ) : (
                      <Icon className="h-3 w-3" />
                    )}
                    <span className="font-medium">{idx + 1}.</span>
                  </span>
                  <span className="block mt-1 truncate">{s.title}</span>
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card data-testid={`step-${effective}`}>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="rounded-md bg-primary/10 p-2 text-primary">
                <StepIcon className="h-5 w-5" />
              </div>
              <div>
                <CardTitle className="text-lg">
                  {STEPS[stepIndex]?.title ?? "Setup complete"}
                </CardTitle>
                <p className="text-sm text-muted-foreground mt-1">
                  {STEPS[stepIndex]?.blurb}
                </p>
              </div>
            </div>
            {completedKeys.has(effective) ? (
              <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200">
                <CheckCircle2 className="h-3 w-3 mr-1" /> Done
              </Badge>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <StepBody
            step={effective}
            readiness={readiness}
            isOrgAdmin={isOrgAdmin}
          />
        </CardContent>
      </Card>

      <div className="flex justify-between">
        <Button
          variant="outline"
          disabled={stepIndex === 0}
          onClick={() => {
            const prev = STEPS[Math.max(0, stepIndex - 1)];
            if (prev) jumpTo(prev.key);
          }}
        >
          Back
        </Button>
        <Button
          onClick={advance}
          disabled={patchM.isPending}
          data-testid="step-advance"
        >
          {stepIndex === totalSteps - 1 ? "Finish setup" : "Mark done & continue"}{" "}
          <ArrowRight className="h-4 w-4 ml-1" />
        </Button>
      </div>
    </div>
  );
}

function StepBody({
  step,
  readiness,
  isOrgAdmin,
}: {
  step: OnboardingWizardStep;
  readiness: ReadinessResponse | undefined;
  isOrgAdmin: boolean;
}) {
  switch (step) {
    case "welcome":
      return <WelcomeStep readiness={readiness} />;
    case "bring_data":
      return <BringDataStep readiness={readiness} isOrgAdmin={isOrgAdmin} />;
    case "map_categories":
      return <MapCategoriesStep readiness={readiness} />;
    case "invite_team":
      return <InviteTeamStep />;
    case "configure_settings":
      return <ConfigureSettingsStep />;
    case "run_first_cycle":
      return <RunFirstCycleStep readiness={readiness} />;
    case "completed":
      return (
        <p className="text-sm text-muted-foreground">
          You're all set. Head back to the{" "}
          <Link href="/" className="text-primary hover:underline">
            dashboard
          </Link>{" "}
          to track opportunities.
        </p>
      );
  }
}

function WelcomeStep({ readiness }: { readiness: ReadinessResponse | undefined }) {
  return (
    <div className="space-y-4">
      <p className="text-sm">
        Atlas Procure turns your spend, contract and supplier data into an OODA loop:
        Observe → Orient → Decide → Act → Learn. Each step in this wizard
        wires up the inputs the loop needs.
      </p>
      <div className="grid sm:grid-cols-2 gap-3">
        <FactCard
          label="Levers active"
          value={readiness ? `${readiness.levers.length}` : "—"}
        />
        <FactCard
          label="Data readiness"
          value={readiness ? `${readiness.overallScore}%` : "—"}
        />
      </div>
    </div>
  );
}

function FactCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-lg font-semibold mt-1">{value}</div>
    </div>
  );
}

function BringDataStep({
  readiness,
  isOrgAdmin,
}: {
  readiness: ReadinessResponse | undefined;
  isOrgAdmin: boolean;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const installM = useInstallSampleData({
    mutation: {
      onSuccess: (data) => {
        toast({
          title: data.installed ? "Sample data installed" : "Sample data ready",
          description: `${data.counts.purchaseOrders} POs · ${data.counts.invoices} invoices · ${data.counts.suppliers} suppliers`,
        });
        qc.invalidateQueries({ queryKey: getGetReadinessQueryKey() });
      },
      onError: (e: Error) =>
        toast({ title: "Install failed", description: String(e) }),
    },
  });
  const removeM = useRemoveSampleData({
    mutation: {
      onSuccess: () => {
        toast({ title: "Sample data removed" });
        qc.invalidateQueries({ queryKey: getGetReadinessQueryKey() });
      },
      onError: (e: Error) =>
        toast({ title: "Remove failed", description: String(e) }),
    },
  });
  const installed = readiness?.sampleDataInstalled ?? false;

  return (
    <div className="space-y-4">
      <div className="grid md:grid-cols-3 gap-3">
        <ChoiceCard
          icon={UploadCloud}
          title="Upload CSVs"
          body="Bring suppliers, contracts, POs, invoices and payments in our standard schema."
          href="/ingest"
          ctaLabel="Open ingest"
        />
        <ChoiceCard
          icon={SettingsIcon}
          title="Connect an ERP"
          body="Wire up SAP Ariba, Coupa or another connector for ongoing sync."
          href="/integrations"
          ctaLabel="Open integrations"
        />
        <div className="rounded-md border p-4 flex flex-col">
          <FlaskConical className="h-5 w-5 text-primary" />
          <h3 className="font-semibold mt-2">Load sample data</h3>
          <p className="text-xs text-muted-foreground mt-1 flex-1">
            Drop in a curated synthetic dataset to preview every lever.
            Org admin only — removable in one click.
          </p>
          {installed ? (
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => removeM.mutate()}
              disabled={removeM.isPending || !isOrgAdmin}
              data-testid="remove-sample-data-btn"
            >
              {removeM.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
              ) : (
                <Trash2 className="h-3 w-3 mr-1" />
              )}
              Remove sample data
            </Button>
          ) : (
            <Button
              size="sm"
              className="mt-3"
              onClick={() => installM.mutate()}
              disabled={installM.isPending || !isOrgAdmin}
              data-testid="install-sample-data-btn"
            >
              {installM.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
              ) : (
                <FlaskConical className="h-3 w-3 mr-1" />
              )}
              Install sample data
            </Button>
          )}
          {!isOrgAdmin ? (
            <p className="text-xs text-muted-foreground mt-2">
              Requires the org_admin role.
            </p>
          ) : null}
        </div>
      </div>
      {readiness ? (
        <ReadinessSummary readiness={readiness} />
      ) : null}
    </div>
  );
}

function MapCategoriesStep({
  readiness,
}: {
  readiness: ReadinessResponse | undefined;
}) {
  // Surface the levers that are *blocked specifically by category data*
  // so the user can see what category mapping unlocks. We single out
  // the canonical category-driven plays:
  //   • tail_spend_rationalization (needs categories on PO lines)
  //   • supplier_consolidation (needs categories to bucket suppliers)
  //   • spot_vs_contract / material_index_arbitrage (need
  //     `categories.code` matched against canonical FRED PPI/CPI scope
  //     codes — that match is the "PPI/CPI confirmation" the wizard
  //     promises).
  const tail = readiness?.levers.find(
    (l) => l.leverId === "tail_spend_rationalization",
  );
  const consolidation = readiness?.levers.find(
    (l) => l.leverId === "supplier_consolidation",
  );
  const spot = readiness?.levers.find((l) => l.leverId === "spot_vs_contract");
  const matIdx = readiness?.levers.find(
    (l) => l.leverId === "material_index_arbitrage",
  );
  const ppiCpiMatched =
    (spot?.score ?? 0) >= 100 && (matIdx?.score ?? 0) >= 100;

  return (
    <div className="space-y-3">
      <p className="text-sm">
        Atlas Procure buckets PO lines by category to power tail-spend, supplier
        consolidation and indirect-category plays. Categories whose code
        matches a canonical PPI/CPI series unlock the FRED-driven{" "}
        <em>spot-vs-contract</em> and <em>material index arbitrage</em>{" "}
        levers.
      </p>
      <Button asChild variant="outline" size="sm">
        <Link href="/spend">
          Review category mapping <ArrowRight className="h-3 w-3 ml-1" />
        </Link>
      </Button>

      <div
        className={`rounded-md border p-3 text-xs flex items-start gap-2 ${
          ppiCpiMatched
            ? "bg-emerald-50 border-emerald-200 text-emerald-900"
            : "bg-amber-50 border-amber-200 text-amber-900"
        }`}
        data-testid="ppi-cpi-status"
      >
        {ppiCpiMatched ? (
          <CheckCircle2 className="h-4 w-4 mt-0.5" />
        ) : (
          <CircleDashed className="h-4 w-4 mt-0.5" />
        )}
        <div>
          <strong>
            {ppiCpiMatched
              ? "PPI/CPI confirmed"
              : "PPI/CPI matching pending"}
          </strong>{" "}
          —{" "}
          {ppiCpiMatched
            ? "every required canonical scope code matches a tenant category."
            : "spot-vs-contract and material-index plays will stay dark until your category codes line up with the canonical PPI/CPI scope codes."}
        </div>
      </div>

      {[tail, consolidation, spot, matIdx]
        .filter((l): l is NonNullable<typeof l> => Boolean(l && l.blockers[0]))
        .slice(0, 3)
        .map((l) => (
          <div
            key={l.leverId}
            className="text-xs text-muted-foreground rounded-md bg-slate-50 border border-slate-200 p-3"
            data-testid={`map-cats-blocker-${l.leverId}`}
          >
            <strong className="text-slate-900">{l.label}:</strong>{" "}
            {l.blockers[0]?.message}
          </div>
        ))}
    </div>
  );
}

function InviteTeamStep() {
  return (
    <div className="space-y-3">
      <p className="text-sm">
        Add buyers, approvers and analysts so the right people see the right
        opportunities. Roles map to permissions like opportunity approval and
        cycle execution.
      </p>
      <Button asChild variant="outline" size="sm">
        <Link href="/admin">
          Manage team <ArrowRight className="h-3 w-3 ml-1" />
        </Link>
      </Button>
    </div>
  );
}

function ConfigureSettingsStep() {
  return (
    <div className="space-y-3">
      <p className="text-sm">
        Set your contract renewal-alert window, your insight disclosure
        policy, and the success-fee terms before you start running cycles.
      </p>
      <Button asChild variant="outline" size="sm">
        <Link href="/settings">
          Open settings <ArrowRight className="h-3 w-3 ml-1" />
        </Link>
      </Button>
    </div>
  );
}

function RunFirstCycleStep({
  readiness,
}: {
  readiness: ReadinessResponse | undefined;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [triggered, setTriggered] = useState(false);

  // Poll the cycles list while a cycle is in flight so we can render
  // a real-time progress UI (running → completed/failed) without a
  // heavyweight WebSocket. 2s refresh tracks the OODA inner loop.
  const cyclesQ = useListCycles({
    query: {
      queryKey: getListCyclesQueryKey(),
      refetchInterval: triggered ? 2_000 : false,
    },
  });
  const latest: Cycle | undefined = cyclesQ.data?.[0];
  const inflight =
    triggered && latest != null && latest.status === "running";
  const justFinished =
    triggered && latest != null && latest.status === "completed";

  const runM = useRunNextCycle({
    mutation: {
      onSuccess: (resp) => {
        setTriggered(true);
        toast({
          title: "Cycle queued",
          description:
            "jobId" in resp
              ? `Job ${resp.jobId} queued — watching for completion…`
              : `${resp.opportunitiesCreated} opportunities created`,
        });
        qc.invalidateQueries({ queryKey: getListCyclesQueryKey() });
      },
      onError: (e: Error) =>
        toast({ title: "Cycle failed", description: String(e) }),
    },
  });

  const ready = (readiness?.overallScore ?? 0) > 0;
  return (
    <div className="space-y-3">
      <p className="text-sm">
        Trigger the first OODA cycle. Atlas Procure will run the lever analyzers,
        score opportunities and surface them on the dashboard.
      </p>
      <Button
        onClick={() => runM.mutate({ params: {} })}
        disabled={runM.isPending || !ready || inflight}
        data-testid="run-first-cycle-btn"
      >
        {runM.isPending || inflight ? (
          <Loader2 className="h-4 w-4 animate-spin mr-1" />
        ) : (
          <Play className="h-4 w-4 mr-1" />
        )}
        {inflight ? "Cycle running…" : "Run cycle now"}
      </Button>
      {!ready ? (
        <p className="text-xs text-muted-foreground">
          Bring data first — the analyzer needs at least one populated lever.
        </p>
      ) : null}

      {triggered && latest ? (
        <div
          className={`rounded-md border p-3 text-sm space-y-2 ${
            latest.status === "completed"
              ? "bg-emerald-50 border-emerald-200"
              : latest.status === "failed"
                ? "bg-rose-50 border-rose-200"
                : "bg-slate-50 border-slate-200"
          }`}
          data-testid="cycle-progress"
        >
          <div className="flex items-center gap-2">
            {latest.status === "running" ? (
              <Loader2 className="h-4 w-4 animate-spin text-slate-600" />
            ) : latest.status === "completed" ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            ) : (
              <CircleDashed className="h-4 w-4 text-rose-600" />
            )}
            <span className="font-medium">
              Cycle #{latest.generation} — {latest.status}
            </span>
          </div>
          {/* Indeterminate bar while running, full at 100% when done. */}
          <Progress
            value={latest.status === "running" ? 60 : 100}
            className="h-2"
          />
          {justFinished ? (
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 pt-1">
              <span className="text-xs text-emerald-900">
                {latest.opportunitiesCreated} opportunities ·{" "}
                {Math.round(latest.totalProjectedUsd).toLocaleString()} USD
                projected
              </span>
              <Button
                size="sm"
                onClick={() => setLocation("/")}
                data-testid="cycle-go-to-dashboard"
              >
                See your opportunities <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ChoiceCard({
  icon: Icon,
  title,
  body,
  href,
  ctaLabel,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: string;
  href: string;
  ctaLabel: string;
}) {
  return (
    <div className="rounded-md border p-4 flex flex-col">
      <Icon className="h-5 w-5 text-primary" />
      <h3 className="font-semibold mt-2">{title}</h3>
      <p className="text-xs text-muted-foreground mt-1 flex-1">{body}</p>
      <Button asChild variant="outline" size="sm" className="mt-3">
        <Link href={href}>
          {ctaLabel} <ArrowRight className="h-3 w-3 ml-1" />
        </Link>
      </Button>
    </div>
  );
}

function ReadinessSummary({ readiness }: { readiness: ReadinessResponse }) {
  const ranked = [...readiness.levers].sort((a, b) => a.score - b.score);
  return (
    <div className="rounded-md border p-3 space-y-2">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium">Lever readiness</span>
        <Badge variant="secondary">{readiness.overallScore}%</Badge>
      </div>
      <ul className="space-y-1 text-xs" data-testid="bring-data-readiness">
        {ranked.slice(0, 5).map((l) => (
          <li key={l.leverId} className="flex items-center justify-between">
            <span className="flex items-center gap-1.5">
              {l.score === 100 ? (
                <CheckCircle2 className="h-3 w-3 text-emerald-600" />
              ) : (
                <CircleDashed className="h-3 w-3 text-amber-600" />
              )}
              {l.label}
            </span>
            <span className="font-mono text-muted-foreground">{l.score}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Keep the unused export so tests can import the type if needed.
export type { OnboardingState };
