import { useEffect, useRef } from "react";
import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { ClerkProvider, useClerk } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { shadcn } from "@clerk/themes";
import { useQueryClient } from "@tanstack/react-query";

import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";

import { Layout } from "./components/layout";
import Landing from "./pages/landing";
import Dashboard from "./pages/dashboard";
import SpendOverview from "./pages/spend";
import SupplierDetail from "./pages/supplier-detail";
import Opportunities from "./pages/opportunities";
import OpportunityDetail from "./pages/opportunity-detail";
import Contracts from "./pages/contracts";
import ContractDetail from "./pages/contract-detail";
import Approvals from "./pages/approvals";
import Ooda from "./pages/ooda";
import Results from "./pages/results";
import Playbook from "./pages/playbook";
import Collectors from "./pages/collectors";
import DataSources from "./pages/data-sources";
import System from "./pages/system";
import Ingest from "./pages/ingest";
import Integrations from "./pages/integrations";
import Settings from "./pages/settings";
import WatchedCompanies from "./pages/watched-companies";
import Admin from "./pages/admin";
import { SignInPage, SignUpPage } from "./pages/auth";
import { useMyRole } from "./lib/use-my-role";

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
 * Gate the /admin route on the resolved RBAC role from
 * `/api/admin/whoami`. Non-admins get a friendly 403; unauthenticated
 * users (no roles + no API key) are sent to /sign-in.
 */
function AdminGuard({ children }: { children: React.ReactNode }) {
  const { data, isLoading, isOrgAdmin } = useMyRole();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!isLoading && data && data.roles.length === 0) {
      setLocation("/sign-in");
    }
  }, [data, isLoading, setLocation]);

  if (isLoading) {
    return (
      <div className="p-12 text-sm text-muted-foreground">Loading…</div>
    );
  }
  if (!isOrgAdmin) {
    return (
      <div className="p-12">
        <h1 className="text-2xl font-bold mb-2">403 — Forbidden</h1>
        <p className="text-muted-foreground">
          You need the org_admin role to view this page.
        </p>
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

function AppRoutes() {
  return (
    <Switch>
      <Route path="/landing" component={Landing} />
      <Route path="/sign-in/*?" component={SignInPage} />
      <Route path="/sign-up/*?" component={SignUpPage} />
      <Route>
        <Layout>
          <Switch>
            <Route path="/" component={Dashboard} />
            <Route path="/spend" component={SpendOverview} />
            <Route path="/suppliers/:id" component={SupplierDetail} />
            <Route path="/opportunities" component={Opportunities} />
            <Route path="/opportunities/:id" component={OpportunityDetail} />
            <Route path="/contracts" component={Contracts} />
            <Route path="/contracts/:id" component={ContractDetail} />
            <Route path="/approvals" component={Approvals} />
            <Route path="/ooda" component={Ooda} />
            <Route path="/results" component={Results} />
            <Route path="/playbook" component={Playbook} />
            <Route path="/collectors" component={Collectors} />
            <Route path="/data-sources" component={DataSources} />
            <Route path="/system" component={System} />
            <Route path="/ingest" component={Ingest} />
            <Route path="/integrations" component={Integrations} />
            <Route path="/watched-companies" component={WatchedCompanies} />
            <Route path="/settings" component={Settings} />
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
      <AppRoutes />
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
