import { useEffect, useState } from "react";
import { Link } from "wouter";
import { X } from "lucide-react";

/**
 * One-time, dismissable migration banner shown after the IA redesign
 * (#199, step 7). Three elements only — acknowledgement line, mapping
 * link, dismiss button — informational, not a tutorial.
 *
 * Auto-hides 7 days after first impression. Persistence is per-user
 * localStorage; no server state.
 */
const STORAGE_KEY = "procuro.ia.migration.dismissedAt";
const FIRST_SEEN_KEY = "procuro.ia.migration.firstSeenAt";
const AUTO_HIDE_DAYS = 7;

export function MigrationBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const dismissed = window.localStorage.getItem(STORAGE_KEY);
    if (dismissed) {
      setVisible(false);
      return;
    }
    const firstSeen = window.localStorage.getItem(FIRST_SEEN_KEY);
    const now = Date.now();
    if (!firstSeen) {
      window.localStorage.setItem(FIRST_SEEN_KEY, String(now));
      setVisible(true);
      return;
    }
    const age = now - Number.parseInt(firstSeen, 10);
    const maxAge = AUTO_HIDE_DAYS * 24 * 60 * 60 * 1000;
    if (Number.isFinite(age) && age > maxAge) {
      window.localStorage.setItem(STORAGE_KEY, String(now));
      setVisible(false);
      return;
    }
    setVisible(true);
  }, []);

  if (!visible) return null;

  const dismiss = () => {
    window.localStorage.setItem(STORAGE_KEY, String(Date.now()));
    setVisible(false);
  };

  return (
    <div
      data-testid="migration-banner"
      className="border-b border-blue-100 bg-blue-50 px-8 py-2 text-sm text-blue-900 flex items-center justify-between gap-4"
    >
      <div>
        <span className="font-semibold">The navigation changed.</span>{" "}
        <Link
          href="/whats-new"
          className="underline font-medium"
          data-testid="migration-banner-link"
        >
          See what moved →
        </Link>
      </div>
      <button
        type="button"
        onClick={dismiss}
        data-testid="migration-banner-dismiss"
        className="text-blue-900 hover:text-blue-700 inline-flex items-center gap-1 text-xs underline"
        aria-label="Dismiss"
      >
        <X className="w-3.5 h-3.5" /> Dismiss
      </button>
    </div>
  );
}
