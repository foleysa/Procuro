import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import App from "./App";
import "./index.css";

const originalFetch = window.fetch;
window.fetch = (input, init = {}) => {
  const orgId = localStorage.getItem("activeOrgId") ?? "";
  const headers = new Headers(init.headers);
  if (orgId && !headers.has("x-org-id")) headers.set("x-org-id", orgId);
  return originalFetch(input, { ...init, headers });
};

const queryClient = new QueryClient();

const BOOTSTRAP_VERSION = "v2-scis-default";

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
            // Prefer the SCIS demo org if seeded; otherwise pick the first.
            const preferred =
              orgs.find((o) => o.slug === "scis") ?? orgs[0];
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
        <p className="mt-4 text-sm text-muted-foreground font-medium">Bootscribing System...</p>
      </div>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Bootstrap />);
