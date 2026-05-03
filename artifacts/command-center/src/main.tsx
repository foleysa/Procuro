import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import App from "./App";
import { ErrorBoundary } from "./components/error-boundary";
import "./index.css";

// Forward the active tenant on every same-origin /api/* request. We must
// NOT add this header on external requests (e.g. Clerk's frontend API)
// — they will reject the preflight because `x-org-id` is not on their
// Access-Control-Allow-Headers allowlist.
const originalFetch = window.fetch;
function isInternalApiRequest(input: RequestInfo | URL): boolean {
  try {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (!raw) return false;
    if (raw.startsWith("/api/") || raw === "/api") return true;
    const u = new URL(raw, window.location.origin);
    return u.origin === window.location.origin && u.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}
window.fetch = (input, init = {}) => {
  if (!isInternalApiRequest(input)) {
    return originalFetch(input, init);
  }
  const orgId = localStorage.getItem("activeOrgId") ?? "";
  const orgAdminToken = localStorage.getItem("orgAdminToken") ?? "";
  const headers = new Headers(init.headers);
  if (orgId && !headers.has("x-org-id")) headers.set("x-org-id", orgId);
  if (orgAdminToken && !headers.has("x-org-admin-token")) {
    headers.set("x-org-admin-token", orgAdminToken);
  }
  return originalFetch(input, { ...init, headers });
};

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: false,
    },
  },
});

const BOOTSTRAP_VERSION = "v4-procuro-reseed";

function Bootstrap() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    async function init() {
      const seenVersion = localStorage.getItem("bootstrapVersion");
      const cached = localStorage.getItem("activeOrgId");
      const needsPick = !cached || seenVersion !== BOOTSTRAP_VERSION;

      if (needsPick) {
        try {
          const res = await fetch("/api/orgs");
          const orgs: { id: string; slug: string }[] = await res.json();
          if (orgs && orgs.length > 0) {
            const preferred =
              orgs.find((o) => o.slug === "scis-procurement") ?? orgs[0]!;
            localStorage.setItem("activeOrgId", preferred.id);
            localStorage.setItem("bootstrapVersion", BOOTSTRAP_VERSION);
          }
        } catch (e) {
          console.error("Failed to fetch initial orgs", e);
        }
      }
      setReady(true);
    }
    init();
  }, []);

  if (!ready) {
    return (
      <div className="min-h-screen w-full flex flex-col items-center justify-center bg-background text-foreground">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
        <p className="mt-4 text-sm text-muted-foreground font-medium">
          Bootstrapping Atlas Procure...
        </p>
      </div>
    );
  }

  return (
    <ErrorBoundary scope="Atlas Procure">
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

createRoot(document.getElementById("root")!).render(<Bootstrap />);
