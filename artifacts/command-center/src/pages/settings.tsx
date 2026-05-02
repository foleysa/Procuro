import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useMyRole } from "@/lib/use-my-role";
import {
  getGetMeQueryKey,
  useGetMe,
  usePatchMeSettings,
  useListMeSettingsAudit,
  useListAlertChannels,
  useCreateAlertChannel,
  usePatchAlertChannel,
  useDeleteAlertChannel,
  useTestAlertChannel,
  useListAlertSubscriptions,
  useCreateAlertSubscription,
  usePatchAlertSubscription,
  useDeleteAlertSubscription,
  useListWatchlists,
  getListAlertChannelsQueryKey,
  getListAlertSubscriptionsQueryKey,
  getListMeSettingsAuditQueryKey,
  getListWatchlistsQueryKey,
  type DisclosurePolicy,
  type AlertChannel,
  type AlertChannelKind,
  type AlertSeverity,
  type AlertSubscription,
  type OrgSettingsAuditEntry,
} from "@workspace/api-client-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  Settings as SettingsIcon,
  Loader2,
  Eye,
  Bell,
  Plus,
  Trash2,
  Mail,
  Webhook,
  MessageSquare,
  History,
  CalendarClock,
} from "lucide-react";

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
  const { data } = useGetMe();

  return (
    <div className="p-8 space-y-6 max-w-4xl">
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

      <Tabs defaultValue="disclosure" className="space-y-4">
        <TabsList>
          <TabsTrigger value="disclosure" data-testid="tab-disclosure">
            Disclosure
          </TabsTrigger>
          <TabsTrigger value="notifications" data-testid="tab-notifications">
            Notifications
          </TabsTrigger>
        </TabsList>

        <TabsContent value="disclosure" className="space-y-4">
          <DisclosurePolicySection />
          <SettingsHistorySection />
        </TabsContent>

        <TabsContent value="notifications" className="space-y-4">
          <RenewalAlertSection />
          <ChannelsSection />
          <SubscriptionsSection />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ============================ Disclosure ============================

function DisclosurePolicySection() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useGetMe();
  const { isOrgAdmin, isLoading: roleLoading } = useMyRole();

  const currentPolicy: DisclosurePolicy | undefined = data?.org.disclosurePolicy;
  const [selected, setSelected] = useState<DisclosurePolicy | undefined>(
    currentPolicy,
  );

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
        qc.setQueryData(getGetMeQueryKey(), resp);
        qc.invalidateQueries({ queryKey: getGetMeQueryKey() });
        // Audit list lives at a different key — invalidate it so the
        // history block under this card refreshes immediately rather
        // than waiting for the next tab switch.
        qc.invalidateQueries({ queryKey: getListMeSettingsAuditQueryKey() });
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
  const canEdit = isOrgAdmin;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Eye className="w-5 h-5" />
          Source disclosure policy
        </CardTitle>
        <CardDescription>
          Controls how much sourcing detail the citation block reveals on
          opportunities and OODA cycles. The more permissive the policy, the
          more lower-trust signals (T3 / T4) are surfaced to your team.
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
            disabled={!canEdit}
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
          {canEdit ? (
            <>
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
            </>
          ) : (
            <span
              data-testid="text-policy-readonly"
              className="text-xs text-muted-foreground"
            >
              {roleLoading
                ? "Checking permissions…"
                : "Only org admins can change tenant-wide settings."}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ============================ Renewal alert lead time ============================

const MIN_RENEWAL_ALERT_DAYS = 1;
const MAX_RENEWAL_ALERT_DAYS = 365;

/**
 * Lets admins tune how many days before a contract's expiry the daily
 * `renewal_alert_scan` worker should surface it. Server-side default
 * is 90 days (`ORG_DEFAULT_RENEWAL_ALERT_DAYS`); the API accepts an
 * integer in [1, 365] and rejects anything outside that range. We
 * mirror those bounds in the input control and show a friendly inline
 * error before the request is even attempted, so admins don't see a
 * raw 400 from the server.
 */
function RenewalAlertSection() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useGetMe();

  const currentDays = data?.org.contractRenewalAlertDays;
  // Stored as a string so the field can be temporarily empty while
  // the admin is typing — the parser below validates the final value
  // before we enable the Save button.
  const [draft, setDraft] = useState<string>("");

  useEffect(() => {
    if (typeof currentDays === "number") setDraft(String(currentDays));
  }, [currentDays]);

  const trimmed = draft.trim();
  let parsed: number | null = null;
  let error: string | null = null;
  if (trimmed === "") {
    error = "Enter a number of days between 1 and 365.";
  } else {
    const n = Number(trimmed);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      error = "Enter a whole number of days.";
    } else if (n < MIN_RENEWAL_ALERT_DAYS || n > MAX_RENEWAL_ALERT_DAYS) {
      error = `Pick a value between ${MIN_RENEWAL_ALERT_DAYS} and ${MAX_RENEWAL_ALERT_DAYS} days.`;
    } else {
      parsed = n;
    }
  }

  const patchM = usePatchMeSettings({
    mutation: {
      onSuccess: (resp) => {
        toast({
          title: "Renewal alert lead time updated",
          description: `Contracts expiring within ${resp.org.contractRenewalAlertDays} day${resp.org.contractRenewalAlertDays === 1 ? "" : "s"} will trigger a renewal alert.`,
        });
        qc.setQueryData(getGetMeQueryKey(), resp);
        qc.invalidateQueries({ queryKey: getGetMeQueryKey() });
        qc.invalidateQueries({ queryKey: getListMeSettingsAuditQueryKey() });
      },
      onError: (e: Error) =>
        toast({
          title: "Could not save renewal alert window",
          description: String(e),
          variant: "destructive",
        }),
    },
  });

  const saving = patchM.isPending;
  // "Dirty" tracks whether the user has touched the field at all
  // (string-level comparison) so the inline error renders even when
  // they've blanked the input. Save eligibility additionally requires
  // a valid parsed value that actually differs from the saved one.
  const dirty =
    typeof currentDays === "number" ? draft !== String(currentDays) : true;
  const canSave = parsed !== null && parsed !== currentDays && !saving;

  return (
    <Card data-testid="card-renewal-alert">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarClock className="w-5 h-5" />
          Renewal alert lead time
        </CardTitle>
        <CardDescription>
          How many days before a contract's expiry the daily renewal scan
          should surface it as a renewal alert. Lower values produce a
          tighter, more urgent feed; higher values give your team more
          runway to plan the renegotiation.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="flex items-center text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            Loading current value…
          </div>
        ) : (
          <div className="space-y-2 max-w-xs">
            <Label htmlFor="renewal-alert-days">Days before expiry</Label>
            <Input
              id="renewal-alert-days"
              type="number"
              inputMode="numeric"
              min={MIN_RENEWAL_ALERT_DAYS}
              max={MAX_RENEWAL_ALERT_DAYS}
              step={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              aria-invalid={dirty && error ? true : undefined}
              data-testid="input-renewal-alert-days"
            />
            {dirty && error ? (
              <p
                className="text-xs text-destructive"
                data-testid="text-renewal-alert-error"
              >
                {error}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Allowed range: {MIN_RENEWAL_ALERT_DAYS}–{MAX_RENEWAL_ALERT_DAYS}{" "}
                days. The next daily scan will use the saved value.
              </p>
            )}
          </div>
        )}

        <div className="flex items-center gap-3">
          <Button
            data-testid="button-save-renewal-alert"
            disabled={!canSave}
            onClick={() => {
              if (parsed === null) return;
              patchM.mutate({ data: { contractRenewalAlertDays: parsed } });
            }}
          >
            {saving ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Saving…
              </>
            ) : (
              "Save lead time"
            )}
          </Button>
          {dirty && !saving && parsed !== null && parsed !== currentDays ? (
            <span className="text-xs text-muted-foreground">
              Unsaved change
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

// ============================ Settings history ============================

/**
 * Renders the most recent N entries in `org_settings_audit_log` for
 * the active tenant — "Last changed by alice@…, 2h ago" for each
 * settings key. The full data is one round-trip behind the policy
 * card so the user sees their just-saved change reflected without a
 * page refresh; the audit list is invalidated by the PATCH success
 * handler above.
 */
function SettingsHistorySection() {
  const params = { limit: 10 } as const;
  const auditQ = useListMeSettingsAudit(params, {
    query: { queryKey: getListMeSettingsAuditQueryKey(params) },
  });
  const entries: OrgSettingsAuditEntry[] = auditQ.data ?? [];

  return (
    <Card data-testid="card-settings-history">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <History className="w-5 h-5" />
          Recent changes
        </CardTitle>
        <CardDescription>
          Most recent changes to tenant-wide preferences. Compliance-grade:
          every save records the actor, the key, and the previous value.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {auditQ.isLoading ? (
          <div className="flex items-center text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            Loading history…
          </div>
        ) : entries.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            No settings changes recorded yet. The first save will appear here.
          </div>
        ) : (
          <ul className="divide-y" data-testid="list-settings-history">
            {entries.map((e) => (
              <SettingsHistoryRow key={e.id} entry={e} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

const SETTINGS_KEY_LABELS: Record<string, string> = {
  disclosurePolicy: "Disclosure policy",
  contractRenewalAlertDays: "Renewal alert window",
};

function labelForKey(key: string): string {
  return SETTINGS_KEY_LABELS[key] ?? key;
}

/**
 * Format an audit value for display. The audit log uses a JSONB
 * `unknown` payload so we don't have a static type to lean on — render
 * primitives verbatim, stringify objects compactly, and render the
 * literal "—" for absent values so an empty cell never collapses.
 */
function formatAuditValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Render a relative timestamp that always degrades gracefully — the
 * audit list ships ISO strings and we keep the formatter inline rather
 * than pulling in `date-fns` just for this card.
 */
function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const diffMs = Date.now() - then;
  if (diffMs < 60_000) return "just now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function SettingsHistoryRow({ entry }: { entry: OrgSettingsAuditEntry }) {
  const oldText = formatAuditValue(entry.oldValue);
  const newText = formatAuditValue(entry.newValue);
  return (
    <li
      className="py-3 flex items-start gap-3"
      data-testid={`row-settings-history-${entry.id}`}
    >
      <div className="flex-1 min-w-0 space-y-1">
        <div className="text-sm font-medium flex items-center gap-2 flex-wrap">
          <span data-testid={`text-history-key-${entry.id}`}>
            {labelForKey(entry.key)}
          </span>
          <Badge variant="outline" className="text-[10px]">
            {oldText} → {newText}
          </Badge>
        </div>
        <div
          className="text-xs text-muted-foreground"
          data-testid={`text-history-actor-${entry.id}`}
        >
          Changed by{" "}
          <span className="font-medium text-foreground">
            {entry.actorEmail}
          </span>{" "}
          · {formatRelativeTime(entry.createdAt)}
        </div>
      </div>
    </li>
  );
}

// ============================ Channels ============================

function ChannelsSection() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [createOpen, setCreateOpen] = useState(false);

  const channelsQ = useListAlertChannels({
    query: { queryKey: getListAlertChannelsQueryKey() },
  });
  const channels = channelsQ.data?.items ?? [];

  const createM = useCreateAlertChannel({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListAlertChannelsQueryKey() });
        setCreateOpen(false);
        toast({ title: "Channel created" });
      },
      onError: (e: Error) =>
        toast({
          title: "Could not create channel",
          description: String(e),
          variant: "destructive",
        }),
    },
  });
  const patchM = usePatchAlertChannel({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListAlertChannelsQueryKey() });
      },
    },
  });
  const deleteM = useDeleteAlertChannel({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListAlertChannelsQueryKey() });
        toast({ title: "Channel deleted" });
      },
      onError: (e: Error) =>
        toast({
          title: "Could not delete channel",
          description: String(e),
          variant: "destructive",
        }),
    },
  });
  const testM = useTestAlertChannel({
    mutation: {
      onSuccess: (result) => {
        toast({
          title: `Test ${result.status}`,
          description: result.error
            ? result.error
            : result.providerMessageId
              ? `provider message id: ${result.providerMessageId}`
              : "Adapter accepted the test payload.",
        });
      },
      onError: (e: Error) =>
        toast({
          title: "Test failed",
          description: String(e),
          variant: "destructive",
        }),
    },
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Bell className="w-5 h-5" />
            Notification channels
          </CardTitle>
          <CardDescription>
            Where alerts are sent. Email goes through SendGrid (or simulated if
            no key is configured); webhooks are signed with HMAC-SHA256.
          </CardDescription>
        </div>
        <Button
          size="sm"
          onClick={() => setCreateOpen(true)}
          data-testid="button-new-channel"
        >
          <Plus className="w-4 h-4 mr-2" /> New channel
        </Button>
      </CardHeader>
      <CardContent>
        {channelsQ.isLoading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : channels.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            No notification channels configured. Add an email or webhook to
            start receiving alerts.
          </div>
        ) : (
          <ul className="divide-y" data-testid="list-channels">
            {channels.map((c) => (
              <li
                key={c.id}
                className="py-3 flex items-center gap-3"
                data-testid={`row-channel-${c.id}`}
              >
                <ChannelKindIcon kind={c.kind} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium flex items-center gap-2">
                    {c.name}
                    <Badge variant="outline" className="text-[10px]">
                      {c.kind}
                    </Badge>
                    {!c.enabled && (
                      <Badge
                        variant="outline"
                        className="text-[10px] text-muted-foreground"
                      >
                        disabled
                      </Badge>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5 truncate">
                    {summarizeChannelConfig(c)}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Switch
                    checked={c.enabled}
                    onCheckedChange={(v) =>
                      patchM.mutate({ id: c.id, data: { enabled: v } })
                    }
                    data-testid={`switch-channel-enabled-${c.id}`}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={
                      testM.isPending && testM.variables?.id === c.id
                    }
                    onClick={() => testM.mutate({ id: c.id })}
                    data-testid={`button-test-channel-${c.id}`}
                  >
                    Test
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      if (
                        window.confirm(
                          `Delete channel "${c.name}"? Subscriptions using it will stop delivering.`,
                        )
                      ) {
                        deleteM.mutate({ id: c.id });
                      }
                    }}
                    data-testid={`button-delete-channel-${c.id}`}
                  >
                    <Trash2 className="w-3.5 h-3.5 text-muted-foreground" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <CreateChannelDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        busy={createM.isPending}
        onCreate={(data) => createM.mutate({ data })}
      />
    </Card>
  );
}

function CreateChannelDialog({
  open,
  onOpenChange,
  busy,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  busy: boolean;
  onCreate: (data: {
    kind: AlertChannelKind;
    name: string;
    config: Record<string, unknown>;
    enabled?: boolean;
  }) => void;
}) {
  const [kind, setKind] = useState<AlertChannelKind>("email");
  const [name, setName] = useState("");
  // Email
  const [emailTo, setEmailTo] = useState("");
  const [emailFrom, setEmailFrom] = useState("");
  // Webhook / slack / teams
  const [webhookUrl, setWebhookUrl] = useState("");
  const [signingSecret, setSigningSecret] = useState("");

  const reset = () => {
    setKind("email");
    setName("");
    setEmailTo("");
    setEmailFrom("");
    setWebhookUrl("");
    setSigningSecret("");
  };

  const buildConfig = (): Record<string, unknown> => {
    if (kind === "email") {
      return {
        to: emailTo
          .split(/[\s,]+/)
          .map((s) => s.trim())
          .filter(Boolean),
        from: emailFrom.trim() || undefined,
      };
    }
    return {
      url: webhookUrl.trim(),
      signingSecret: signingSecret.trim() || undefined,
    };
  };

  const valid =
    name.trim().length > 0 &&
    (kind === "email" ? emailTo.trim().length > 0 : webhookUrl.trim().length > 0);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent data-testid="dialog-create-channel">
        <DialogHeader>
          <DialogTitle>New notification channel</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Type</Label>
            <Select
              value={kind}
              onValueChange={(v) => setKind(v as AlertChannelKind)}
            >
              <SelectTrigger data-testid="select-channel-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="email">Email</SelectItem>
                <SelectItem value="webhook">Webhook (HMAC-signed)</SelectItem>
                <SelectItem value="slack">Slack incoming webhook</SelectItem>
                <SelectItem value="teams">Teams incoming webhook</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ch-name">Name</Label>
            <Input
              id="ch-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Risk team email"
              data-testid="input-channel-name"
            />
          </div>

          {kind === "email" ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="ch-to">Recipients (comma-separated)</Label>
                <Input
                  id="ch-to"
                  value={emailTo}
                  onChange={(e) => setEmailTo(e.target.value)}
                  placeholder="risk@example.com, ops@example.com"
                  data-testid="input-channel-to"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ch-from">From (optional)</Label>
                <Input
                  id="ch-from"
                  value={emailFrom}
                  onChange={(e) => setEmailFrom(e.target.value)}
                  placeholder="alerts@yourdomain.com"
                  data-testid="input-channel-from"
                />
                <p className="text-xs text-muted-foreground">
                  Defaults to a Procuro-managed sender if you skip this.
                </p>
              </div>
            </>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="ch-url">Webhook URL</Label>
                <Input
                  id="ch-url"
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                  placeholder="https://hooks.example.com/…"
                  data-testid="input-channel-url"
                />
              </div>
              {kind === "webhook" && (
                <div className="space-y-2">
                  <Label htmlFor="ch-sig">Signing secret (optional)</Label>
                  <Textarea
                    id="ch-sig"
                    value={signingSecret}
                    onChange={(e) => setSigningSecret(e.target.value)}
                    rows={2}
                    placeholder="A long random secret used to HMAC-SHA256 the request body"
                    data-testid="input-channel-secret"
                  />
                  <p className="text-xs text-muted-foreground">
                    The signature is sent as <code>X-Procuro-Signature</code>.
                    Skip if your endpoint is already authenticated.
                  </p>
                </div>
              )}
            </>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            disabled={!valid || busy}
            onClick={() =>
              onCreate({
                kind,
                name: name.trim(),
                config: buildConfig(),
              })
            }
            data-testid="button-create-channel"
          >
            {busy ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Plus className="w-4 h-4 mr-2" />
            )}
            Create channel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================ Subscriptions ============================

function SubscriptionsSection() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: me } = useGetMe();
  const userId = me?.user.id ?? "";

  const params = userId ? { userId } : undefined;
  const subsQ = useListAlertSubscriptions(params, {
    query: {
      queryKey: getListAlertSubscriptionsQueryKey(params),
      enabled: Boolean(userId),
    },
  });
  const channelsQ = useListAlertChannels({
    query: { queryKey: getListAlertChannelsQueryKey() },
  });
  const watchlistsQ = useListWatchlists({
    query: { queryKey: getListWatchlistsQueryKey() },
  });

  const subs = subsQ.data?.items ?? [];
  const channels = channelsQ.data?.items ?? [];
  const watchlists = watchlistsQ.data?.items ?? [];
  const channelById = new Map(channels.map((c) => [c.id, c]));
  const watchlistById = new Map(watchlists.map((w) => [w.id, w]));

  const createM = useCreateAlertSubscription({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({
          queryKey: getListAlertSubscriptionsQueryKey(params),
        });
        toast({ title: "Subscription created" });
      },
      onError: (e: Error) =>
        toast({
          title: "Could not subscribe",
          description: String(e),
          variant: "destructive",
        }),
    },
  });
  const patchM = usePatchAlertSubscription({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({
          queryKey: getListAlertSubscriptionsQueryKey(params),
        });
      },
    },
  });
  const deleteM = useDeleteAlertSubscription({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({
          queryKey: getListAlertSubscriptionsQueryKey(params),
        });
        toast({ title: "Unsubscribed" });
      },
    },
  });

  const [newChannelId, setNewChannelId] = useState("");
  const [newSeverity, setNewSeverity] =
    useState<AlertSeverity>("medium");
  const [newWatchlistId, setNewWatchlistId] = useState<string>("__any__");

  const canCreate = Boolean(userId) && Boolean(newChannelId);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bell className="w-5 h-5" />
          Your alert subscriptions
        </CardTitle>
        <CardDescription>
          Decide which alerts hit which of your channels. You'll only receive
          alerts at or above the chosen severity, optionally scoped to a
          watchlist.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {channels.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            Add a notification channel above before subscribing.
          </div>
        ) : (
          <div className="border rounded-md p-3 space-y-3 bg-muted/20">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              New subscription
            </div>
            <div className="grid sm:grid-cols-3 gap-2">
              <Select value={newChannelId} onValueChange={setNewChannelId}>
                <SelectTrigger data-testid="select-sub-channel">
                  <SelectValue placeholder="Channel" />
                </SelectTrigger>
                <SelectContent>
                  {channels.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name} ({c.kind})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={newSeverity}
                onValueChange={(v) => setNewSeverity(v as AlertSeverity)}
              >
                <SelectTrigger data-testid="select-sub-severity">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="info">≥ Info (everything)</SelectItem>
                  <SelectItem value="low">≥ Low</SelectItem>
                  <SelectItem value="medium">≥ Medium</SelectItem>
                  <SelectItem value="high">≥ High</SelectItem>
                  <SelectItem value="critical">Critical only</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={newWatchlistId}
                onValueChange={setNewWatchlistId}
              >
                <SelectTrigger data-testid="select-sub-watchlist">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__any__">Any subject</SelectItem>
                  {watchlists.map((w) => (
                    <SelectItem key={w.id} value={w.id}>
                      Watchlist: {w.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              size="sm"
              disabled={!canCreate || createM.isPending}
              onClick={() => {
                if (!userId) return;
                createM.mutate({
                  data: {
                    userId,
                    channelId: newChannelId,
                    severityThreshold: newSeverity,
                    watchlistId:
                      newWatchlistId === "__any__" ? null : newWatchlistId,
                  },
                });
                setNewChannelId("");
                setNewSeverity("medium");
                setNewWatchlistId("__any__");
              }}
              data-testid="button-subscribe"
            >
              <Plus className="w-4 h-4 mr-2" /> Subscribe
            </Button>
          </div>
        )}

        {subsQ.isLoading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : subs.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            You don't have any subscriptions yet. Add one above.
          </div>
        ) : (
          <ul className="divide-y" data-testid="list-subscriptions">
            {subs.map((s) => (
              <SubscriptionRow
                key={s.id}
                sub={s}
                channel={channelById.get(s.channelId) ?? null}
                watchlistName={
                  s.watchlistId
                    ? (watchlistById.get(s.watchlistId)?.name ??
                      s.watchlistId)
                    : null
                }
                onToggle={(enabled) =>
                  patchM.mutate({ id: s.id, data: { enabled } })
                }
                onDelete={() => deleteM.mutate({ id: s.id })}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function SubscriptionRow({
  sub,
  channel,
  watchlistName,
  onToggle,
  onDelete,
}: {
  sub: AlertSubscription;
  channel: AlertChannel | null;
  watchlistName: string | null;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
}) {
  return (
    <li
      className="py-3 flex items-center gap-3"
      data-testid={`row-sub-${sub.id}`}
    >
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">
          {channel ? channel.name : "(deleted channel)"}{" "}
          <span className="text-muted-foreground font-normal">
            via {channel?.kind ?? "?"}
          </span>
        </div>
        <div className="text-xs text-muted-foreground mt-0.5">
          ≥ {sub.severityThreshold}
          {watchlistName ? ` · scoped to "${watchlistName}"` : " · all subjects"}
          {sub.digest && sub.digest !== "realtime" ? ` · ${sub.digest}` : ""}
        </div>
      </div>
      <Switch
        checked={sub.enabled}
        onCheckedChange={onToggle}
        data-testid={`switch-sub-enabled-${sub.id}`}
      />
      <Button
        variant="ghost"
        size="icon"
        onClick={onDelete}
        data-testid={`button-delete-sub-${sub.id}`}
      >
        <Trash2 className="w-3.5 h-3.5 text-muted-foreground" />
      </Button>
    </li>
  );
}

// ============================ Helpers ============================

function ChannelKindIcon({ kind }: { kind: AlertChannelKind }) {
  if (kind === "email")
    return <Mail className="w-4 h-4 text-muted-foreground" />;
  if (kind === "webhook")
    return <Webhook className="w-4 h-4 text-muted-foreground" />;
  return <MessageSquare className="w-4 h-4 text-muted-foreground" />;
}

function summarizeChannelConfig(c: AlertChannel): string {
  const cfg = c.config ?? {};
  if (c.kind === "email") {
    const to = (cfg["to"] as unknown[] | undefined) ?? [];
    return to.length > 0 ? `to: ${to.join(", ")}` : "no recipients";
  }
  const url = (cfg["url"] as string | undefined) ?? "";
  return url ? `url: ${url}` : "no url";
}

