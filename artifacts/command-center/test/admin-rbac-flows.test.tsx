/**
 * Task #153 — UI coverage for the Org Admin invite / rotate / revoke flows.
 *
 * Server-side RBAC is exhaustively covered by node:test suites
 * (`rbac-enforcement.test.ts`, `admin-api-keys.test.ts`). The React admin
 * surface in `src/pages/admin.tsx` was previously only smoke-tested by
 * hand. This file pins the user-facing contract for the two highest-risk
 * flows on that page:
 *
 *   1. Users tab: invite a teammate, change their role from the row, then
 *      revoke them. Verifies the invited row appears as "Pending", the
 *      role-change PATCH is sent with the right body, and the revoke
 *      action flips the row to the "Revoked" badge with the action
 *      buttons disabled.
 *
 *   2. API keys tab: issue a key, see the one-shot "Save this secret now"
 *      reveal card with the plaintext bearer, dismiss it, rotate the key
 *      (verifying a new secret is revealed and the original key flips to
 *      Revoked), and finally revoke the rotated key.
 *
 * The harness mocks `@/lib/admin-client` with a stateful in-memory store
 * so list queries pick up mutations exactly the way React Query
 * invalidation would in production. `useMyRole` is mocked to grant
 * `org_admin` so the page renders without hitting `/api/admin/whoami`.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import * as React from "react";

// ---- Radix UI polyfills (jsdom misses pointer-capture + scrollIntoView)
//
// Radix Select / Popover use `hasPointerCapture` and call `scrollIntoView`
// on the highlighted item. jsdom ships neither, which causes the
// `<SelectContent>` portal to silently fail to open under userEvent.
if (!(Element.prototype as unknown as { hasPointerCapture?: unknown })
  .hasPointerCapture) {
  Element.prototype.hasPointerCapture = (() => false) as Element["hasPointerCapture"];
}
if (!(Element.prototype as unknown as { releasePointerCapture?: unknown })
  .releasePointerCapture) {
  Element.prototype.releasePointerCapture =
    (() => undefined) as Element["releasePointerCapture"];
}
if (!(Element.prototype as unknown as { setPointerCapture?: unknown })
  .setPointerCapture) {
  Element.prototype.setPointerCapture =
    (() => undefined) as Element["setPointerCapture"];
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = (() => undefined) as Element["scrollIntoView"];
}

// ---- Stateful in-memory admin-client mock ------------------------------
//
// Models the server: `listX` returns the current snapshot; mutations
// modify the snapshot so the subsequent React Query invalidation pulls
// the new state. Rotate revokes the original key in the same instant the
// replacement is issued — same contract as `admin-api-keys.ts` enforces.

type AdminUserRole =
  | "platform_admin"
  | "org_admin"
  | "approver"
  | "analyst"
  | "read_only"
  | "auditor";

interface AdminUserRow {
  id: string;
  userId: string;
  email: string;
  role: AdminUserRole;
  grantedVia: string;
  grantedBy: string;
  createdAt: string;
  revokedAt: string | null;
  active: boolean;
}

interface AdminApiKeyRow {
  id: string;
  label: string;
  prefix: string;
  scopeRole: AdminUserRole;
  createdAt: string;
  createdBy: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  rotatedFromId: string | null;
}

interface AdminApiKeyIssued extends AdminApiKeyRow {
  secret: string;
}

const { store, calls } = vi.hoisted(() => {
  const s = {
    users: [] as AdminUserRow[],
    keys: [] as AdminApiKeyRow[],
    nextUserSeq: 1,
    nextKeySeq: 1,
    nextSecretSeq: 1,
  };
  const c = {
    inviteUser: [] as Array<{ email: string; role: string }>,
    changeUserRole: [] as Array<{ id: string; role: string }>,
    revokeUser: [] as string[],
    issueKey: [] as Array<{ label: string; scopeRole: string }>,
    rotateKey: [] as string[],
    revokeKey: [] as string[],
  };
  return { store: s, calls: c };
});

vi.mock("@/lib/admin-client", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/admin-client")
  >("@/lib/admin-client");
  // Reuse the real ROLE_OPTIONS array so the dropdowns render with the
  // production label / hint text — keeps the test honest about which
  // option labels are click targets.
  return {
    ...actual,
    adminClient: {
      listUsers: async (): Promise<AdminUserRow[]> => store.users.map((u) => ({ ...u })),
      inviteUser: async (
        email: string,
        role: AdminUserRole,
      ): Promise<{ id: string; email: string; role: AdminUserRole; pending: boolean }> => {
        calls.inviteUser.push({ email, role });
        const id = `u_${store.nextUserSeq++}`;
        const row: AdminUserRow = {
          id,
          userId: `pending:${email}`,
          email,
          role,
          grantedVia: "invite",
          grantedBy: "agent@test.local",
          createdAt: new Date().toISOString(),
          revokedAt: null,
          active: true,
        };
        store.users.push(row);
        return { id, email, role, pending: true };
      },
      changeUserRole: async (id: string, role: AdminUserRole) => {
        calls.changeUserRole.push({ id, role });
        const u = store.users.find((u) => u.id === id);
        if (u) u.role = role;
        return { id, email: u?.email ?? "", role };
      },
      revokeUser: async (id: string) => {
        calls.revokeUser.push(id);
        const u = store.users.find((u) => u.id === id);
        if (u) {
          u.active = false;
          u.revokedAt = new Date().toISOString();
        }
        return { id, revoked: true };
      },

      listKeys: async (): Promise<AdminApiKeyRow[]> =>
        store.keys.map((k) => ({ ...k })),
      issueKey: async (
        label: string,
        scopeRole: AdminUserRole,
      ): Promise<AdminApiKeyIssued> => {
        calls.issueKey.push({ label, scopeRole });
        const id = `k_${store.nextKeySeq++}`;
        const secret = `sk_test_${store.nextSecretSeq++}_${Math.random()
          .toString(36)
          .slice(2, 10)}`;
        const row: AdminApiKeyRow = {
          id,
          label,
          prefix: secret.slice(0, 12),
          scopeRole,
          createdAt: new Date().toISOString(),
          createdBy: "agent@test.local",
          lastUsedAt: null,
          revokedAt: null,
          rotatedFromId: null,
        };
        store.keys.push(row);
        return { ...row, secret };
      },
      rotateKey: async (id: string): Promise<AdminApiKeyIssued> => {
        calls.rotateKey.push(id);
        const old = store.keys.find((k) => k.id === id);
        if (!old) throw new Error(`unknown key ${id}`);
        old.revokedAt = new Date().toISOString();
        const newId = `k_${store.nextKeySeq++}`;
        const secret = `sk_test_${store.nextSecretSeq++}_${Math.random()
          .toString(36)
          .slice(2, 10)}`;
        const row: AdminApiKeyRow = {
          id: newId,
          label: old.label,
          prefix: secret.slice(0, 12),
          scopeRole: old.scopeRole,
          createdAt: new Date().toISOString(),
          createdBy: "agent@test.local",
          lastUsedAt: null,
          revokedAt: null,
          rotatedFromId: id,
        };
        store.keys.push(row);
        return { ...row, secret };
      },
      revokeKey: async (id: string) => {
        calls.revokeKey.push(id);
        const k = store.keys.find((k) => k.id === id);
        if (k) k.revokedAt = new Date().toISOString();
        return { id, revoked: true };
      },

      // SSO / tenant / audit are unused on these flows. Earlier
      // revisions of `adminClient` exported method shims for them; the
      // real module no longer does (those endpoints are consumed via
      // generated React Query hooks now), so we don't re-export them.
    },
  };
});

vi.mock("@/lib/use-my-role", () => ({
  useMyRole: () => ({
    data: {
      orgId: "org_test",
      email: "agent@test.local",
      roles: ["org_admin"] as const,
      viaApiKey: false,
      authMode: "session",
    },
    isLoading: false,
    isOrgAdmin: true,
    isPlatformAdmin: false,
    hasRole: () => true,
    isSignedIn: true,
  }),
}));

const { default: AdminPage } = await import("../src/pages/admin");

// ---- helpers -----------------------------------------------------------

function renderAdmin() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const memory = memoryLocation({ path: "/admin", record: true });
  // userEvent v14: bypass pointer-events checks so Radix Select / Tabs
  // dropdowns work reliably under jsdom.
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  return {
    user,
    qc,
    memory,
    ...render(
      <QueryClientProvider client={qc}>
        <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
          <AdminPage />
        </WouterRouter>
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  store.users = [];
  store.keys = [];
  store.nextUserSeq = 1;
  store.nextKeySeq = 1;
  store.nextSecretSeq = 1;
  calls.inviteUser = [];
  calls.changeUserRole = [];
  calls.revokeUser = [];
  calls.issueKey = [];
  calls.rotateKey = [];
  calls.revokeKey = [];
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---- 1. Users tab: invite → change role → revoke ----------------------

describe("<AdminPage /> Users tab", () => {
  test("invites a teammate, changes their role inline, then revokes them", async () => {
    const { user } = renderAdmin();

    // Default tab is users — confirm chrome rendered.
    expect(screen.getByTestId("text-page-title")).toHaveTextContent(
      /Org Admin/i,
    );
    // Empty state appears once the (empty) listUsers query resolves;
    // the card briefly renders "Loading users…" first.
    expect(
      await screen.findByText(/No members yet\./i),
    ).toBeInTheDocument();

    // Invite happy path.
    const email = `mate-${Math.random().toString(36).slice(2, 8)}@acme.test`;
    await user.type(screen.getByTestId("input-invite-email"), email);
    await user.click(screen.getByTestId("button-send-invite"));

    // The mocked POST resolved → the table refetched and rendered the
    // new pending row.
    await waitFor(() => {
      expect(calls.inviteUser).toEqual([{ email, role: "analyst" }]);
    });
    const userId = store.users[0]!.id;
    const row = await screen.findByTestId(`row-user-${userId}`);
    expect(within(row).getByText(email)).toBeInTheDocument();
    expect(within(row).getByText(/Pending/i)).toBeInTheDocument();

    // The invite-email input is cleared after success — pin that small
    // affordance so a refactor can't silently regress it.
    expect(
      (screen.getByTestId("input-invite-email") as HTMLInputElement).value,
    ).toBe("");

    // Change role from analyst → approver via the per-row Radix Select.
    await user.click(screen.getByTestId(`select-role-${userId}`));
    // The portal renders SelectItems as listbox options; click the
    // "Approver" entry by its label.
    const approverOption = await screen.findByRole("option", {
      name: /Approver/i,
    });
    await user.click(approverOption);

    await waitFor(() => {
      expect(calls.changeUserRole).toEqual([
        { id: userId, role: "approver" },
      ]);
    });
    // After the mutation invalidates, the row's select should now show
    // "Approver" as the displayed value.
    await waitFor(() => {
      expect(
        screen.getByTestId(`select-role-${userId}`),
      ).toHaveTextContent(/Approver/i);
    });

    // Revoke. The trash button fires the DELETE; the next list refresh
    // returns active=false, which flips the badge and disables actions.
    await user.click(screen.getByTestId(`button-revoke-${userId}`));

    await waitFor(() => {
      expect(calls.revokeUser).toEqual([userId]);
    });
    const revokedRow = await screen.findByTestId(`row-user-${userId}`);
    await waitFor(() => {
      expect(within(revokedRow).getByText(/Revoked/i)).toBeInTheDocument();
    });
    // Action buttons are disabled once active=false (the row-level
    // Select trigger and the revoke button both gate on `u.active`).
    expect(screen.getByTestId(`button-revoke-${userId}`)).toBeDisabled();
    expect(screen.getByTestId(`select-role-${userId}`)).toBeDisabled();
  });
});

// ---- 2. API keys tab: issue → reveal-once → rotate → revoke -----------

describe("<AdminPage /> API keys tab", () => {
  test("issues a key, surfaces the one-time secret, rotates it, then revokes the rotated key", async () => {
    const { user } = renderAdmin();

    // Switch to the API keys tab.
    await user.click(screen.getByTestId("tab-api-keys"));
    expect(
      await screen.findByText(/Issue a new API key/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/No keys issued yet\./i)).toBeInTheDocument();
    // No one-time-secret card before any issuance.
    expect(screen.queryByTestId("text-issued-secret")).toBeNull();

    // ---- Issue a fresh key ----
    const label = `nightly-backup-${Math.random()
      .toString(36)
      .slice(2, 6)}`;
    await user.type(screen.getByTestId("input-key-label"), label);
    await user.click(screen.getByTestId("button-issue-key"));

    await waitFor(() => {
      expect(calls.issueKey).toEqual([
        { label, scopeRole: "analyst" },
      ]);
    });
    // The one-time reveal card mounts with the plaintext secret AND
    // the warning copy that the secret will not be shown again.
    const revealEl = await screen.findByTestId("text-issued-secret");
    const issuedKeyId = store.keys[0]!.id;
    const issuedSecret = revealEl.textContent ?? "";
    expect(issuedSecret).toMatch(/^sk_test_/);
    expect(screen.getByText(/Save this secret now/i)).toBeInTheDocument();
    expect(
      screen.getByText(/will not be shown again/i),
    ).toBeInTheDocument();
    // The label input is cleared after a successful issue.
    expect(
      (screen.getByTestId("input-key-label") as HTMLInputElement).value,
    ).toBe("");

    // The new key shows up in the table as Active. The row also shows
    // the truncated prefix (so operators can recognise the key in logs)
    // and the scope-role badge — both worth pinning so a future
    // refactor of the key card can't silently drop them.
    const issuedRow = await screen.findByTestId(`row-key-${issuedKeyId}`);
    expect(within(issuedRow).getByText(label)).toBeInTheDocument();
    expect(within(issuedRow).getByText(/Active/i)).toBeInTheDocument();
    const issuedPrefix = store.keys.find((k) => k.id === issuedKeyId)!.prefix;
    expect(
      within(issuedRow).getByText(new RegExp(`^${issuedPrefix}`)),
    ).toBeInTheDocument();
    expect(within(issuedRow).getByText(/^analyst$/)).toBeInTheDocument();

    // Dismiss the reveal card → the secret is no longer in the DOM.
    await user.click(
      screen.getByRole("button", { name: /I've saved it — dismiss/i }),
    );
    await waitFor(() => {
      expect(screen.queryByTestId("text-issued-secret")).toBeNull();
    });

    // ---- Rotate the key ----
    //
    // Rotating must (a) reveal a NEW one-shot secret, distinct from the
    // first, (b) flip the original row to Revoked, and (c) leave the
    // replacement row Active. The action buttons on the revoked row
    // must also be disabled.
    await user.click(screen.getByTestId(`button-rotate-${issuedKeyId}`));
    await waitFor(() => {
      expect(calls.rotateKey).toEqual([issuedKeyId]);
    });
    const rotatedReveal = await screen.findByTestId("text-issued-secret");
    const rotatedSecret = rotatedReveal.textContent ?? "";
    expect(rotatedSecret).toMatch(/^sk_test_/);
    expect(rotatedSecret).not.toBe(issuedSecret);
    const rotatedKeyId = store.keys[1]!.id;
    expect(rotatedKeyId).not.toBe(issuedKeyId);
    expect(store.keys.find((k) => k.id === rotatedKeyId)?.rotatedFromId).toBe(
      issuedKeyId,
    );

    // Original row → Revoked badge, rotate + revoke buttons disabled.
    const oldRow = await screen.findByTestId(`row-key-${issuedKeyId}`);
    await waitFor(() => {
      expect(within(oldRow).getByText(/Revoked/i)).toBeInTheDocument();
    });
    expect(
      screen.getByTestId(`button-rotate-${issuedKeyId}`),
    ).toBeDisabled();
    expect(
      screen.getByTestId(`button-revoke-key-${issuedKeyId}`),
    ).toBeDisabled();

    // Replacement row → Active. Same scope role as the original (the
    // rotate route preserves it) and the same label, with a fresh prefix
    // distinct from the revoked key's prefix.
    const newRow = await screen.findByTestId(`row-key-${rotatedKeyId}`);
    expect(within(newRow).getByText(/Active/i)).toBeInTheDocument();
    expect(within(newRow).getByText(label)).toBeInTheDocument();
    expect(within(newRow).getByText(/^analyst$/)).toBeInTheDocument();
    const rotatedPrefix = store.keys.find((k) => k.id === rotatedKeyId)!.prefix;
    expect(rotatedPrefix).not.toBe(
      store.keys.find((k) => k.id === issuedKeyId)!.prefix,
    );
    expect(
      within(newRow).getByText(new RegExp(`^${rotatedPrefix}`)),
    ).toBeInTheDocument();

    // Dismiss the second reveal so the next assertion isn't polluted.
    await user.click(
      screen.getByRole("button", { name: /I've saved it — dismiss/i }),
    );

    // ---- Revoke the rotated key ----
    await user.click(
      screen.getByTestId(`button-revoke-key-${rotatedKeyId}`),
    );
    await waitFor(() => {
      expect(calls.revokeKey).toEqual([rotatedKeyId]);
    });
    const revokedNewRow = await screen.findByTestId(
      `row-key-${rotatedKeyId}`,
    );
    await waitFor(() => {
      expect(
        within(revokedNewRow).getByText(/Revoked/i),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId(`button-rotate-${rotatedKeyId}`),
    ).toBeDisabled();
    expect(
      screen.getByTestId(`button-revoke-key-${rotatedKeyId}`),
    ).toBeDisabled();
  });

  test("does not surface a one-time secret card on initial load", async () => {
    const { user } = renderAdmin();
    await user.click(screen.getByTestId("tab-api-keys"));
    expect(
      await screen.findByText(/Issue a new API key/i),
    ).toBeInTheDocument();
    // The one-shot reveal must only mount AFTER an issue/rotate. A
    // future regression that surfaced the card on every navigation
    // would defeat the whole point of the reveal-once contract.
    expect(screen.queryByTestId("text-issued-secret")).toBeNull();
    expect(screen.queryByText(/Save this secret now/i)).toBeNull();
  });
});
