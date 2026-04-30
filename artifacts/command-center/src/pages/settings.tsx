import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetMeQueryKey,
  useGetMe,
  usePatchMeSettings,
  type DisclosurePolicy,
} from "@workspace/api-client-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Settings as SettingsIcon, Loader2, Eye } from "lucide-react";

/**
 * Plain-language description of what each disclosure tier reveals on
 * insight citations across the product. Mirrors the behaviour of the
 * `renderInsight()` tier renderer so admins can pick the right level
 * for their team without reading source code.
 */
const POLICY_OPTIONS: ReadonlyArray<{
  value: DisclosurePolicy;
  label: string;
  blurb: string;
}> = [
  {
    value: "conservative",
    label: "Conservative",
    blurb:
      "Only the highest-trust sources (T1 contracts and T2 invoices) are attributed on insights.",
  },
  {
    value: "standard",
    label: "Standard",
    blurb:
      "Adds class labels and confidence (T3) on top of conservative — the recommended default.",
  },
  {
    value: "analyst",
    label: "Analyst",
    blurb:
      "Full provenance for every tier including unverified signals (T4). Best for analyst review.",
  },
];

export default function Settings() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useGetMe();

  const currentPolicy: DisclosurePolicy | undefined = data?.org.disclosurePolicy;
  const [selected, setSelected] = useState<DisclosurePolicy | undefined>(
    currentPolicy,
  );

  // Sync the radio selection whenever the server-side value changes
  // (e.g. after the org switcher swaps tenants, or after a save).
  useEffect(() => {
    if (currentPolicy) setSelected(currentPolicy);
  }, [currentPolicy]);

  const patchM = usePatchMeSettings({
    mutation: {
      onSuccess: (resp) => {
        toast({
          title: "Disclosure policy updated",
          description: `Insight citations now use the "${resp.org.disclosurePolicy}" tier.`,
        });
        // The PATCH response is the same `MeResponse` shape as GET
        // /me, so seed the cache directly: every consumer of
        // `usePolicy()` (opportunity citations, OODA cycle citations,
        // the OrgSwitcher) sees the new policy on its next render
        // without waiting for a refetch round-trip. Then invalidate
        // to keep the cache honest if anything else mutates the org.
        qc.setQueryData(getGetMeQueryKey(), resp);
        qc.invalidateQueries({ queryKey: getGetMeQueryKey() });
      },
      onError: (e: Error) =>
        toast({
          title: "Could not save policy",
          description: String(e),
          variant: "destructive",
        }),
    },
  });

  const dirty = selected !== undefined && selected !== currentPolicy;
  const saving = patchM.isPending;

  return (
    <div className="p-8 space-y-6 max-w-3xl">
      <div>
        <h1
          data-testid="text-page-title"
          className="text-3xl font-bold flex items-center gap-2"
        >
          <SettingsIcon className="w-7 h-7 text-primary" />
          Settings
        </h1>
        <p className="text-muted-foreground mt-1">
          Tenant-wide preferences. Changes apply to every member of{" "}
          <span className="font-medium">{data?.org.name ?? "your org"}</span>.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Eye className="w-5 h-5" />
            Source disclosure policy
          </CardTitle>
          <CardDescription>
            Controls how much sourcing detail the citation block reveals on
            opportunities and OODA cycles. The more permissive the policy,
            the more lower-trust signals (T3 / T4) are surfaced to your team.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {isLoading || !selected ? (
            <div className="flex items-center text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Loading current policy…
            </div>
          ) : (
            <RadioGroup
              value={selected}
              onValueChange={(v) => setSelected(v as DisclosurePolicy)}
              data-testid="radio-disclosure-policy"
              className="gap-3"
            >
              {POLICY_OPTIONS.map((opt) => (
                <Label
                  key={opt.value}
                  htmlFor={`policy-${opt.value}`}
                  className="flex items-start gap-3 rounded-md border p-4 cursor-pointer hover:bg-muted/50 transition-colors"
                  data-testid={`option-policy-${opt.value}`}
                >
                  <RadioGroupItem
                    value={opt.value}
                    id={`policy-${opt.value}`}
                    className="mt-1"
                  />
                  <div className="space-y-1">
                    <div className="font-medium">{opt.label}</div>
                    <div className="text-sm text-muted-foreground font-normal">
                      {opt.blurb}
                    </div>
                  </div>
                </Label>
              ))}
            </RadioGroup>
          )}

          <div className="flex items-center gap-3">
            <Button
              data-testid="button-save-policy"
              disabled={!dirty || saving}
              onClick={() => {
                if (!selected) return;
                patchM.mutate({ data: { disclosurePolicy: selected } });
              }}
            >
              {saving ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Saving…
                </>
              ) : (
                "Save policy"
              )}
            </Button>
            {dirty && !saving ? (
              <span className="text-xs text-muted-foreground">
                Unsaved change
              </span>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
