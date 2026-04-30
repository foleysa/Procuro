import { useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import {
  ShieldCheck,
  Users,
  Key,
  Globe2,
  Settings as SettingsIcon,
  History,
  Loader2,
  Trash2,
  RotateCw,
  Copy,
  Download,
} from "lucide-react";
import {
  adminClient,
  ROLE_OPTIONS,
  type AdminUserRole,
  type AdminSsoConfig,
  type AdminTenantSettings,
} from "@/lib/admin-client";

function formatTime(s: string | null | undefined): string {
  if (!s) return "—";
  return new Date(s).toLocaleString();
}

// ----- Users tab ---------------------------------------------------

function UsersTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: users, isLoading } = useQuery({
    queryKey: ["admin", "users"],
    queryFn: () => adminClient.listUsers(),
  });

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AdminUserRole>("analyst");

  const inviteM = useMutation({
    mutationFn: () => adminClient.inviteUser(email, role),
    onSuccess: () => {
      toast({ title: "Invite sent", description: `${email} → ${role}` });
      setEmail("");
      qc.invalidateQueries({ queryKey: ["admin", "users"] });
    },
    onError: (e: Error) =>
      toast({ title: "Could not invite", description: String(e), variant: "destructive" }),
  });

  const changeM = useMutation({
    mutationFn: ({ id, role }: { id: string; role: AdminUserRole }) =>
      adminClient.changeUserRole(id, role),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "users"] }),
    onError: (e: Error) =>
      toast({ title: "Could not change role", description: String(e), variant: "destructive" }),
  });

  const revokeM = useMutation({
    mutationFn: (id: string) => adminClient.revokeUser(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "users"] }),
    onError: (e: Error) =>
      toast({ title: "Could not revoke", description: String(e), variant: "destructive" }),
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="w-5 h-5" />
            Invite a teammate
          </CardTitle>
          <CardDescription>
            They'll receive their assigned role on first sign-in. Pending invites stay
            in the table below until claimed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!email) return;
              inviteM.mutate();
            }}
          >
            <div className="flex-1 min-w-[260px]">
              <Label htmlFor="invite-email">Email</Label>
              <Input
                id="invite-email"
                data-testid="input-invite-email"
                type="email"
                placeholder="teammate@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="min-w-[180px]">
              <Label>Role</Label>
              <Select value={role} onValueChange={(v) => setRole(v as AdminUserRole)}>
                <SelectTrigger data-testid="select-invite-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLE_OPTIONS.map((r) => (
                    <SelectItem key={r.value} value={r.value}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              type="submit"
              data-testid="button-send-invite"
              disabled={!email || inviteM.isPending}
            >
              {inviteM.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : null}
              Send invite
            </Button>
          </form>
          <p className="text-xs text-muted-foreground mt-3">
            {ROLE_OPTIONS.find((r) => r.value === role)?.hint}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
          <CardDescription>
            All users with a role in this tenant. Revoke removes access without
            deleting the audit history.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-sm text-muted-foreground flex items-center">
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Loading users…
            </div>
          ) : !users || users.length === 0 ? (
            <p className="text-sm text-muted-foreground">No members yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Granted via</TableHead>
                  <TableHead>Granted at</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((u) => (
                  <TableRow key={u.id} data-testid={`row-user-${u.id}`}>
                    <TableCell className="font-medium">{u.email}</TableCell>
                    <TableCell>
                      <Select
                        value={u.role}
                        disabled={!u.active}
                        onValueChange={(v) =>
                          changeM.mutate({ id: u.id, role: v as AdminUserRole })
                        }
                      >
                        <SelectTrigger
                          className="w-[160px]"
                          data-testid={`select-role-${u.id}`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ROLE_OPTIONS.map((r) => (
                            <SelectItem key={r.value} value={r.value}>
                              {r.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      {u.active ? (
                        u.userId.startsWith("pending:") ? (
                          <Badge variant="outline">Pending</Badge>
                        ) : (
                          <Badge variant="secondary">Active</Badge>
                        )
                      ) : (
                        <Badge variant="destructive">Revoked</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {u.grantedVia}
                    </TableCell>
                    <TableCell className="text-xs">
                      {formatTime(u.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!u.active}
                        data-testid={`button-revoke-${u.id}`}
                        onClick={() => revokeM.mutate(u.id)}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ----- API keys tab ------------------------------------------------

function ApiKeysTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: keys, isLoading } = useQuery({
    queryKey: ["admin", "api-keys"],
    queryFn: () => adminClient.listKeys(),
  });

  const [label, setLabel] = useState("");
  const [scopeRole, setScopeRole] = useState<AdminUserRole>("analyst");
  const [justIssued, setJustIssued] = useState<{ secret: string; label: string } | null>(null);

  const issueM = useMutation({
    mutationFn: () => adminClient.issueKey(label, scopeRole),
    onSuccess: (resp) => {
      setJustIssued({ secret: resp.secret, label: resp.label });
      setLabel("");
      qc.invalidateQueries({ queryKey: ["admin", "api-keys"] });
    },
    onError: (e: Error) =>
      toast({ title: "Issue failed", description: String(e), variant: "destructive" }),
  });

  const rotateM = useMutation({
    mutationFn: (id: string) => adminClient.rotateKey(id),
    onSuccess: (resp) => {
      setJustIssued({ secret: resp.secret, label: resp.label });
      qc.invalidateQueries({ queryKey: ["admin", "api-keys"] });
    },
    onError: (e: Error) =>
      toast({ title: "Rotate failed", description: String(e), variant: "destructive" }),
  });

  const revokeM = useMutation({
    mutationFn: (id: string) => adminClient.revokeKey(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "api-keys"] }),
    onError: (e: Error) =>
      toast({ title: "Revoke failed", description: String(e), variant: "destructive" }),
  });

  return (
    <div className="space-y-6">
      {justIssued ? (
        <Card className="border-amber-500">
          <CardHeader>
            <CardTitle className="text-amber-600">
              Save this secret now
            </CardTitle>
            <CardDescription>
              <span className="font-medium">{justIssued.label}</span> will not be shown
              again. Copy it into your secret store before leaving this page.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2">
              <code
                className="flex-1 bg-muted p-2 rounded font-mono text-xs break-all"
                data-testid="text-issued-secret"
              >
                {justIssued.secret}
              </code>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void navigator.clipboard.writeText(justIssued.secret);
                  toast({ title: "Copied" });
                }}
              >
                <Copy className="w-4 h-4 mr-2" />
                Copy
              </Button>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setJustIssued(null)}>
              I've saved it — dismiss
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Key className="w-5 h-5" />
            Issue a new API key
          </CardTitle>
          <CardDescription>
            Each key acts with the scope of one role. Keep keys narrow — issue an
            <code className="mx-1">analyst</code> key for read-mostly automation.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!label) return;
              issueM.mutate();
            }}
          >
            <div className="flex-1 min-w-[260px]">
              <Label htmlFor="key-label">Label</Label>
              <Input
                id="key-label"
                data-testid="input-key-label"
                placeholder="e.g. nightly-backup, intern-bot"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
            <div className="min-w-[180px]">
              <Label>Scope role</Label>
              <Select
                value={scopeRole}
                onValueChange={(v) => setScopeRole(v as AdminUserRole)}
              >
                <SelectTrigger data-testid="select-key-scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLE_OPTIONS.filter((r) => r.value !== "platform_admin").map(
                    (r) => (
                      <SelectItem key={r.value} value={r.value}>
                        {r.label}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
            </div>
            <Button
              type="submit"
              data-testid="button-issue-key"
              disabled={!label || issueM.isPending}
            >
              {issueM.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : null}
              Issue key
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Active keys</CardTitle>
          <CardDescription>
            Rotate to issue a replacement; the old key is revoked at the same instant.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-sm text-muted-foreground flex items-center">
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Loading keys…
            </div>
          ) : !keys || keys.length === 0 ? (
            <p className="text-sm text-muted-foreground">No keys issued yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Label</TableHead>
                  <TableHead>Prefix</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((k) => {
                  const revoked = k.revokedAt !== null;
                  return (
                    <TableRow key={k.id} data-testid={`row-key-${k.id}`}>
                      <TableCell className="font-medium">{k.label}</TableCell>
                      <TableCell>
                        <code className="text-xs">{k.prefix}…</code>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{k.scopeRole}</Badge>
                      </TableCell>
                      <TableCell className="text-xs">
                        {formatTime(k.createdAt)}
                      </TableCell>
                      <TableCell className="text-xs">
                        {formatTime(k.lastUsedAt)}
                      </TableCell>
                      <TableCell>
                        {revoked ? (
                          <Badge variant="destructive">Revoked</Badge>
                        ) : (
                          <Badge variant="secondary">Active</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right space-x-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={revoked}
                          data-testid={`button-rotate-${k.id}`}
                          onClick={() => rotateM.mutate(k.id)}
                        >
                          <RotateCw className="w-4 h-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={revoked}
                          data-testid={`button-revoke-key-${k.id}`}
                          onClick={() => revokeM.mutate(k.id)}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ----- SSO tab -----------------------------------------------------

function SsoTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useQuery({
    queryKey: ["admin", "sso"],
    queryFn: () => adminClient.getSso(),
  });

  const [draft, setDraft] = useState<AdminSsoConfig | null>(null);
  const cfg = draft ?? data ?? null;

  const saveM = useMutation({
    mutationFn: (next: AdminSsoConfig) => adminClient.saveSso(next),
    onSuccess: (resp) => {
      qc.setQueryData(["admin", "sso"], resp);
      setDraft(null);
      toast({ title: "SSO updated" });
    },
    onError: (e: Error) =>
      toast({ title: "Save failed", description: String(e), variant: "destructive" }),
  });

  if (isLoading || !cfg) {
    return (
      <div className="text-sm text-muted-foreground flex items-center">
        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
        Loading SSO config…
      </div>
    );
  }

  function update<K extends keyof AdminSsoConfig>(key: K, value: AdminSsoConfig[K]) {
    setDraft({ ...(cfg as AdminSsoConfig), [key]: value });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Globe2 className="w-5 h-5" />
          Single Sign-On
        </CardTitle>
        <CardDescription>
          Procuro federates SAML / OIDC through Clerk. Configure the connection
          in the Clerk Auth pane, then enable it here for your tenant.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <Label>SSO required for this tenant</Label>
            <p className="text-xs text-muted-foreground">
              When on, password sign-in is disabled and only your IdP can vend
              sessions. SCIM provisioning continues to work either way.
            </p>
          </div>
          <Switch
            checked={cfg.enabled}
            onCheckedChange={(v) => update("enabled", v)}
            data-testid="switch-sso-enabled"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label>Protocol</Label>
            <Select
              value={cfg.protocol}
              onValueChange={(v) => update("protocol", v as "saml" | "oidc")}
            >
              <SelectTrigger data-testid="select-sso-protocol">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="saml">SAML 2.0</SelectItem>
                <SelectItem value="oidc">OpenID Connect</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>IdP name</Label>
            <Input
              data-testid="input-sso-idp"
              value={cfg.idpName}
              onChange={(e) => update("idpName", e.target.value)}
              placeholder="okta / azure-ad / onelogin"
            />
          </div>
        </div>

        <div>
          <Label>Email domains (comma-separated)</Label>
          <Input
            data-testid="input-sso-domains"
            value={cfg.emailDomains.join(", ")}
            onChange={(e) =>
              update(
                "emailDomains",
                e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              )
            }
            placeholder="acme.com, eu.acme.com"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label>Clerk connection ID</Label>
            <Input
              value={cfg.clerkConnectionId ?? ""}
              onChange={(e) => update("clerkConnectionId", e.target.value || null)}
              placeholder="con_..."
            />
          </div>
          <div>
            <Label>SAML metadata URL</Label>
            <Input
              value={cfg.metadataUrl ?? ""}
              onChange={(e) => update("metadataUrl", e.target.value || null)}
              placeholder="https://your-idp.okta.com/app/.../sso/saml/metadata"
            />
          </div>
        </div>

        <div>
          <Label>Notes</Label>
          <Textarea
            value={cfg.notes ?? ""}
            onChange={(e) => update("notes", e.target.value || null)}
            placeholder="Onboarding notes — escalation contacts, IdP-side configuration owners, etc."
            rows={3}
          />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <Label>SCIM provisioning</Label>
            <p className="text-xs text-muted-foreground">
              Allow your IdP to push user provision/deprovision events to{" "}
              <code>/api/scim/v2/orgs/&lt;orgId&gt;</code>. Requires an{" "}
              <code>org_admin</code>-scoped API key as the bearer token.
            </p>
          </div>
          <Switch
            checked={cfg.scimEnabled}
            onCheckedChange={(v) => update("scimEnabled", v)}
            data-testid="switch-scim-enabled"
          />
        </div>

        <div className="flex items-center gap-3">
          <Button
            data-testid="button-save-sso"
            disabled={!draft || saveM.isPending}
            onClick={() => draft && saveM.mutate(draft)}
          >
            {saveM.isPending ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : null}
            Save SSO config
          </Button>
          {draft ? (
            <span className="text-xs text-muted-foreground">Unsaved changes</span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

// ----- Tenant settings tab ----------------------------------------

function TenantSettingsTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useQuery({
    queryKey: ["admin", "tenant-settings"],
    queryFn: () => adminClient.getTenantSettings(),
  });
  const [draft, setDraft] = useState<AdminTenantSettings | null>(null);
  const cfg = draft ?? data ?? null;

  const saveM = useMutation({
    mutationFn: (next: AdminTenantSettings) => adminClient.saveTenantSettings(next),
    onSuccess: (resp) => {
      qc.setQueryData(["admin", "tenant-settings"], resp);
      setDraft(null);
      toast({ title: "Tenant settings saved" });
    },
    onError: (e: Error) =>
      toast({ title: "Save failed", description: String(e), variant: "destructive" }),
  });

  if (isLoading || !cfg) {
    return (
      <div className="text-sm text-muted-foreground flex items-center">
        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
        Loading tenant settings…
      </div>
    );
  }

  function update<K extends keyof AdminTenantSettings>(
    key: K,
    value: AdminTenantSettings[K],
  ) {
    setDraft({ ...(cfg as AdminTenantSettings), [key]: value });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <SettingsIcon className="w-5 h-5" />
          Tenant settings
        </CardTitle>
        <CardDescription>
          Tenant-wide commercial and policy levers. Disclosure policy here is the
          same setting as on the Settings page.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label>Success fee %</Label>
            <Input
              type="number"
              step="0.01"
              min="0"
              max="100"
              value={cfg.successFeePct ?? ""}
              onChange={(e) =>
                update("successFeePct", e.target.value === "" ? undefined : Number(e.target.value))
              }
            />
          </div>
          <div>
            <Label>Reporting currency</Label>
            <Input
              value={cfg.baseCurrency ?? ""}
              maxLength={5}
              onChange={(e) => update("baseCurrency", e.target.value.toUpperCase())}
              placeholder="USD"
            />
          </div>
        </div>

        <div>
          <Label>Disclosure policy</Label>
          <Select
            value={cfg.disclosurePolicy ?? "standard"}
            onValueChange={(v) =>
              update("disclosurePolicy", v as AdminTenantSettings["disclosurePolicy"])
            }
          >
            <SelectTrigger data-testid="select-disclosure">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="conservative">Conservative</SelectItem>
              <SelectItem value="standard">Standard (recommended)</SelectItem>
              <SelectItem value="analyst">Analyst</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label>Contract renewal alert (days before)</Label>
            <Input
              type="number"
              min="0"
              max="365"
              value={cfg.contractRenewalAlertDays ?? ""}
              onChange={(e) =>
                update(
                  "contractRenewalAlertDays",
                  e.target.value === "" ? undefined : Number(e.target.value),
                )
              }
            />
          </div>
          <div>
            <Label>Default data retention (days)</Label>
            <Input
              type="number"
              min="30"
              max="3650"
              value={cfg.retentionDefaultDays ?? ""}
              onChange={(e) =>
                update(
                  "retentionDefaultDays",
                  e.target.value === "" ? undefined : Number(e.target.value),
                )
              }
            />
          </div>
        </div>

        <Button
          disabled={!draft || saveM.isPending}
          onClick={() => draft && saveM.mutate(draft)}
          data-testid="button-save-tenant"
        >
          {saveM.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
          Save settings
        </Button>
      </CardContent>
    </Card>
  );
}

// ----- Audit log tab ----------------------------------------------

function AuditTab() {
  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["admin", "audit", actor, action],
    queryFn: () =>
      adminClient.listAudit({
        actor: actor || undefined,
        action: action || undefined,
        limit: 200,
      }),
  });
  const { data: actions } = useQuery({
    queryKey: ["admin", "audit-actions"],
    queryFn: () => adminClient.listAuditActions(),
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <History className="w-5 h-5" />
            Admin audit log
          </CardTitle>
          <CardDescription>
            Append-only record of every admin / RBAC mutation. Export the
            filtered view as CSV for SOC 2 reviewers.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-3 items-end">
            <div>
              <Label>Actor</Label>
              <Input
                data-testid="input-audit-actor"
                value={actor}
                onChange={(e) => setActor(e.target.value)}
                placeholder="email or system principal"
              />
            </div>
            <div className="min-w-[200px]">
              <Label>Action</Label>
              <Select
                value={action || "__all__"}
                onValueChange={(v) => setAction(v === "__all__" ? "" : v)}
              >
                <SelectTrigger data-testid="select-audit-action">
                  <SelectValue placeholder="All actions" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All actions</SelectItem>
                  {actions?.map((a) => (
                    <SelectItem key={a.action} value={a.action}>
                      {a.action} ({a.count})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button variant="outline" onClick={() => refetch()}>
              Refresh
            </Button>
            <Button
              variant="outline"
              data-testid="button-audit-export"
              onClick={() =>
                adminClient.exportAuditCsv({
                  actor: actor || undefined,
                  action: action || undefined,
                })
              }
            >
              <Download className="w-4 h-4 mr-2" />
              Export CSV
            </Button>
          </div>

          {isLoading ? (
            <div className="text-sm text-muted-foreground flex items-center">
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Loading…
            </div>
          ) : !data || data.length === 0 ? (
            <p className="text-sm text-muted-foreground">No matching events.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((row) => (
                  <TableRow key={row.id} data-testid={`row-audit-${row.id}`}>
                    <TableCell className="text-xs whitespace-nowrap">
                      {formatTime(row.createdAt)}
                    </TableCell>
                    <TableCell className="text-xs">{row.actor}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{row.action}</Badge>
                    </TableCell>
                    <TableCell className="text-xs">
                      {row.targetLabel ?? row.targetId ?? "—"}
                    </TableCell>
                    <TableCell className="text-xs">
                      <code className="text-[10px] text-muted-foreground">
                        {Object.keys(row.metadata).length === 0
                          ? ""
                          : JSON.stringify(row.metadata)}
                      </code>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ----- Page shell --------------------------------------------------

export default function AdminPage() {
  const [tab, setTab] = useState("users");
  return (
    <div className="p-8 space-y-6 max-w-6xl">
      <div>
        <h1
          data-testid="text-page-title"
          className="text-3xl font-bold flex items-center gap-2"
        >
          <ShieldCheck className="w-7 h-7 text-primary" />
          Org Admin
        </h1>
        <p className="text-muted-foreground mt-1">
          Manage members, single sign-on, API keys, tenant settings, and the
          admin audit trail.
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          Sharing posture with a customer or auditor? Send them to the{" "}
          <Link
            href="/trust"
            className="text-primary underline-offset-2 hover:underline"
            data-testid="link-admin-trust"
          >
            Trust Center
          </Link>
          {" "}— it's the same data, formatted for review.
        </p>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="users" data-testid="tab-users">
            <Users className="w-4 h-4 mr-2" />
            Users
          </TabsTrigger>
          <TabsTrigger value="sso" data-testid="tab-sso">
            <Globe2 className="w-4 h-4 mr-2" />
            SSO
          </TabsTrigger>
          <TabsTrigger value="api-keys" data-testid="tab-api-keys">
            <Key className="w-4 h-4 mr-2" />
            API keys
          </TabsTrigger>
          <TabsTrigger value="tenant" data-testid="tab-tenant">
            <SettingsIcon className="w-4 h-4 mr-2" />
            Tenant settings
          </TabsTrigger>
          <TabsTrigger value="audit" data-testid="tab-audit">
            <History className="w-4 h-4 mr-2" />
            Audit log
          </TabsTrigger>
        </TabsList>
        <TabsContent value="users" className="mt-6">
          <UsersTab />
        </TabsContent>
        <TabsContent value="sso" className="mt-6">
          <SsoTab />
        </TabsContent>
        <TabsContent value="api-keys" className="mt-6">
          <ApiKeysTab />
        </TabsContent>
        <TabsContent value="tenant" className="mt-6">
          <TenantSettingsTab />
        </TabsContent>
        <TabsContent value="audit" className="mt-6">
          <AuditTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
