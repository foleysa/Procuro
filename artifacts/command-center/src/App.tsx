import { useEffect, useRef } from "react";
import { Switch, Route, Router as WouterRouter, useLocation, Redirect } from "wouter";
import { ClerkProvider, useClerk } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { shadcn } from "@clerk/themes";
import { useQueryClient } from "@tanstack/react-query";
import { Lock } from "lucide-react";

import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import NotFound from "@/pages/not-found";

import { Layout } from "./components/layout";
import Landing from "./pages/landing";
import Dashboard from "./pages/dashboard";
import SpendOverview from "./pages/spend";
import Suppliers from "./pages/suppliers";
import SupplierDetail from "./pages/supplier-detail";
import Opportunities from "./pages/opportunities";
import OpportunityDetail from "./pages/opportunity-detail";
import Contracts from "./pages/contracts";
import ContractDetail from "./pages/contract-detail";
import Services from "./pages/services";
import SowDetail from "./pages/sow-detail";
import RateCardDetail from "./pages/rate-card-detail";
import Approvals from "./pages/approvals";
import Fusion from "./pages/fusion";
import Results from "./pages/results";
import Playbook from "./pages/playbook";
import Collectors from "./pages/collectors";
import DataSources from "./pages/data-sources";
import System from "./pages/system";
import JobDetail from "./pages/job-detail";
import Ingest from "./pages/ingest";
import Integrations from "./pages/integrations";
import Settings from "./pages/settings";
import OnboardingPage from "./pages/onboarding";
import WatchedCompanies from "./pages/watched-companies";
import WatchedUsSuppliers from "./pages/watched-us-suppliers";
import Admin from "./pages/admin";
import Operations from "./pages/operations";
import Engine from "./pages/engine";
import TaxonomyQueue from "./pages/taxonomy-queue";
import WhatsNew from "./pages/whats-new";
import TrustPage from "./pages/trust";
import TrustPublicPage from "./pages/trust-public";
import { SignInPage, SignUpPage } from "./pages/auth";
import { useMyRole } from "./lib/use-my-role";
import { recordEngineAccessDenial } from "@workspace/api-client-react";
import { WarRoomAlertsProvider } from "./lib/use-war-room-alerts";
import Alerts from "./pages/alerts";
import Watchlists from "./pages/watchlists";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

// `publishableKeyFromHost` lets the same build serve multiple Clerk
// custom domains. In dev it falls through to VITE_CLERK_PUBLISHABLE_KEY.
const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);

// In dev this stays empty; in prod the proxy URL is injected by the
// platform.
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL || undefined;

// Clerk's routerPush/routerReplace receive absolute paths including the
// artifact base; wouter's setLocation prepends the base — strip it to
// avoid doubling.
function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: "hsl(221 83% 53%)",
    colorForeground: "hsl(222 47% 11%)",
    colorMutedForeground: "hsl(215 16% 47%)",
    colorDanger: "hsl(0 84% 60%)",
    colorBackground: "hsl(0 0% 100%)",
    colorInput: "hsl(0 0% 100%)",
    colorInputForeground: "hsl(222 47% 11%)",
    colorNeutral: "hsl(214 32% 91%)",
    fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
    borderRadius: "0.625rem",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox:
      "bg-white border border-slate-200 rounded-2xl w-[440px] max-w-full overflow-hidden shadow-xl",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: "text-slate-900 font-semibold",
    headerSubtitle: "text-slate-600",
    socialButtonsBlockButton:
      "border border-slate-200 hover:bg-slate-50 text-slate-900",
    socialButtonsBlockButtonText: "text-slate-900 font-medium",
    formFieldLabel: "text-slate-800 font-medium",
    formFieldInput:
      "bg-white border border-slate-200 text-slate-900 placeholder:text-slate-400",
    formButtonPrimary:
      "bg-[hsl(221_83%_53%)] hover:bg-[hsl(221_83%_47%)] text-white font-semibold",
    footerAction: "text-slate-600",
    footerActionLink: "text-[hsl(221_83%_53%)] hover:underline font-medium",
    footerActionText: "text-slate-600",
    dividerText: "text-slate-500",
    dividerLine: "bg-slate-200",
    identityPreviewEditButton: "text-[hsl(221_83%_53%)]",
    formFieldSuccessText: "text-emerald-600",
    alert: "border border-rose-200 bg-rose-50 text-rose-900",
    alertText: "text-rose-900",
    otpCodeFieldInput: "bg-white border border-slate-200 text-slate-900",
    formFieldRow: "gap-2",
    main: "gap-4",
    logoBox: "mb-4",
    logoImage: "h-8 w-auto",
  },
};

/**
 * Gate admin-only routes (Engine, Operations, Admin) on the resolved
 * RBAC role from `/api/admin/whoami`. Non-admins see a friendly empty
 * state explaining what the page does and how to request access;
 * unauthenticated users (no roles + no API key) are sent to /sign-in.
 *
 * Engine is the most-trafficked entry after the IA flip (#199), so its
 * description is the most specific. Operations and Admin get their own
 * shorter blurbs; everything else falls back to a generic message.
 */
const ADMIN_PAGE_BLURBS: Record<
  string,
  { name: string; what: string }
> = {
  "/engine": {
    name: "Engine",
    what:
      "Engine is where admins run the procurement pipeline — ingest jobs, collectors, approvals routing, and other operational controls.",
  },
  "/admin/taxonomy": {
    name: "Taxonomy queue",
    what:
      "Taxonomy queue is where admins map tenant-supplied category strings to canonical codes so the routing model can place the right levers against them.",
  },
  "/operations": {
    name: "Operations",
    what:
      "Operations is the admin view of pipeline health — collector runs, ingest queues, and system status across the workspace.",
  },
  "/admin": {
    name: "Admin",
    what:
      "Admin is where workspace owners manage members, roles, API keys, and tenant settings.",
  },
};

function AdminGuard({ children }: { children: React.ReactNode }) {
  const { data, isLoading, isOrgAdmin } = useMyRole();
  const [location, setLocation] = useLocation();

  useEffect(() => {
    if (!isLoading && data && data.roles.length === 0) {
      setLocation("/sign-in");
    }
  }, [data, isLoading, setLocation]);

  // #207: emit a one-shot "engine_access_denied" telemetry ping when
  // a signed-in non-admin sees the friendly empty state, so workspace
  // admins get an in-product signal that a teammate is bouncing off
  // a locked page. The server dedupes per-actor per-day so revisits
  // and refreshes don't spam the audit log; failures are swallowed
  // because a UX surface must never be blocked on telemetry.
  useEffect(() => {
    if (isLoading || !data) return;
    if (data.roles.length === 0) return; // unauth → redirected above
    if (isOrgAdmin) return;
    void recordEngineAccessDenial({ route: location }).catch(() => undefined);
  }, [isLoading, data, isOrgAdmin, location]);

  if (isLoading) {
    return (
      <div className="p-12 text-sm text-muted-foreground">Loading…</div>
    );
  }
  if (!isOrgAdmin) {
    // Pick the right blurb for the route the user landed on. Match by
    // prefix so nested admin paths still resolve correctly. Fall back to
    // a generic message if the route isn't in the map.
    const blurb =
      Object.entries(ADMIN_PAGE_BLURBS).find(([prefix]) =>
        location === prefix || location.startsWith(`${prefix}/`),
      )?.[1] ?? {
        name: "this page",
        what: "This page contains admin-only tooling for your workspace.",
      };

    // Build a mailto: with subject + body pre-filled. We don't know who
    // the workspace's owner is, so we leave the recipient blank — the
    // user picks their own admin from their address book. Including the
    // signed-in email in the body lets the admin grant access without a
    // round-trip.
    const userEmail = data?.email ?? "";
    const subject = encodeURIComponent(
      `Requesting access to Procuro ${blurb.name}`,
    );
    const body = encodeURIComponent(
      [
        "Hi,",
        "",
        `Could you grant me access to the ${blurb.name} area in Procuro? I need it for my work.`,
        "",
        userEmail ? `My account: ${userEmail}` : "",
        "",
        "Thanks!",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    const mailto = `mailto:?subject=${subject}&body=${body}`;
    return (
      <div className="p-6 md:p-12">
        <Empty className="border bg-card">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Lock aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>This page is for workspace admins</EmptyTitle>
            <EmptyDescription>
              {blurb.what} Your account doesn&rsquo;t have admin access
              yet, so there&rsquo;s nothing to show here.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button asChild>
              <a href={mailto}>Request access from your admin</a>
            </Button>
            <p className="text-muted-foreground text-xs">
              Already have access on another account? Sign in with that
              email instead.
            </p>
          </EmptyContent>
        </Empty>
      </div>
    );
  }
  return <>{children}</>;
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const queryClient = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (
        prevUserIdRef.current !== undefined &&
        prevUserIdRef.current !== userId
      ) {
        queryClient.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, queryClient]);

  return null;
}

/**
 * `/trust?print=1` (and `/trust/public?print=1`) render without
 * the Layout chrome so the page is suitable for printing or PDF
 * capture by a procurement reviewer.
 * Reading from `window.location` here (rather than wouter's `useSearch`)
 * keeps the conditional out of the React render tree — the route
 * remounts on navigation anyway.
 */
function isTrustPrintMode(): boolean {
  if (typeof window === "undefined") return false;
  if (!window.location.pathname.replace(basePath, "").startsWith("/trust")) {
    return false;
  }
  return new URLSearchParams(window.location.search).get("print") === "1";
}

function AppRoutes() {
  if (isTrustPrintMode()) {
    return (
      <Switch>
        <Route path="/trust/public" component={TrustPublicPage} />
        <Route path="/trust" component={TrustPage} />
        <Route component={NotFound} />
      </Switch>
    );
  }
  return (
    <Switch>
      <Route path="/landing" component={Landing} />
      <Route path="/sign-in/*?" component={SignInPage} />
      <Route path="/sign-up/*?" component={SignUpPage} />
      {/* Public, signed-out preview of the Trust Center (#167). Sits
        * outside the Layout so a procurement reviewer can deep-link
        * during a security questionnaire without being asked to sign
        * in. The authenticated /trust route below is unaffected. */}
      <Route path="/trust/public" component={TrustPublicPage} />
      <Route>
        <Layout>
          <Switch>
            <Route path="/" component={Dashboard} />
            {/* #269: Today and Dashboard merged into one unified
              * landing surface at `/`. Both legacy URLs redirect so
              * bookmarks and email links keep resolving. */}
            <Route path="/dashboard">
              <Redirect to="/" />
            </Route>
            <Route path="/today">
              <Redirect to="/" />
            </Route>
            <Route path="/operations">
              <AdminGuard>
                <Operations />
              </AdminGuard>
            </Route>
            <Route path="/engine">
              <AdminGuard>
                <Engine />
              </AdminGuard>
            </Route>
            {/* Taxonomy queue (#213). Lives under /admin/taxonomy/queue
              * per spec — operators reach it from the Engine section
              * nav, but funnel observability also embeds the same
              * component as a tab so the breakdown links resolve. */}
            <Route path="/admin/taxonomy/queue">
              <AdminGuard>
                <TaxonomyQueue />
              </AdminGuard>
            </Route>
            <Route path="/admin/taxonomy">
              <Redirect to="/admin/taxonomy/queue" />
            </Route>
            {/* Backward-compat redirects (#199 step 7). Old links keep
              * resolving so external bookmarks and email deep-links don't
              * 404 immediately after the IA flip. */}
            <Route path="/admin/funnel">
              <Redirect to="/engine" />
            </Route>
            <Route path="/whats-new" component={WhatsNew} />
            <Route path="/spend" component={SpendOverview} />
            <Route path="/suppliers" component={Suppliers} />
            <Route path="/suppliers/:id" component={SupplierDetail} />
            <Route path="/opportunities" component={Opportunities} />
            <Route path="/opportunities/:id" component={OpportunityDetail} />
            <Route path="/contracts" component={Contracts} />
            <Route path="/contracts/:id" component={ContractDetail} />
            <Route path="/services" component={Services} />
            <Route path="/sows/:id" component={SowDetail} />
            <Route path="/rate-cards/:id" component={RateCardDetail} />
            <Route path="/approvals" component={Approvals} />
            <Route path="/fusion" component={Fusion} />
            <Route path="/alerts" component={Alerts} />
            <Route path="/watchlists" component={Watchlists} />
            <Route path="/results" component={Results} />
            <Route path="/playbook" component={Playbook} />
            <Route path="/collectors" component={Collectors} />
            <Route path="/data-sources" component={DataSources} />
            <Route path="/system" component={System} />
            <Route path="/system/jobs/:id" component={JobDetail} />
            <Route path="/ingest" component={Ingest} />
            <Route path="/integrations" component={Integrations} />
            <Route path="/watched-companies" component={WatchedCompanies} />
            <Route path="/watched-us-suppliers" component={WatchedUsSuppliers} />
            <Route path="/trust" component={TrustPage} />
            <Route path="/settings" component={Settings} />
            <Route path="/onboarding" component={OnboardingPage} />
            <Route path="/admin">
              <AdminGuard>
                <Admin />
              </AdminGuard>
            </Route>
            <Route component={NotFound} />
          </Switch>
        </Layout>
      </Route>
    </Switch>
  );
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  if (!clerkPubKey) {
    return (
      <div className="p-12 text-sm text-destructive">
        Clerk is not configured (missing VITE_CLERK_PUBLISHABLE_KEY).
      </div>
    );
  }

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: {
          start: {
            title: "Sign in to Procuro",
            subtitle: "Procurement-as-a-Service control plane",
          },
        },
        signUp: {
          start: {
            title: "Create your Procuro account",
            subtitle: "Spin up a tenant and invite your team",
          },
        },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <ClerkQueryClientCacheInvalidator />
      <WarRoomAlertsProvider>
        <AppRoutes />
      </WarRoomAlertsProvider>
    </ClerkProvider>
  );
}

function App() {
  return (
    <TooltipProvider>
      <WouterRouter base={basePath}>
        <ClerkProviderWithRoutes />
      </WouterRouter>
      <Toaster />
    </TooltipProvider>
  );
}

export default App;
