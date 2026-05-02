import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  useListIntelligenceEvents,
  getListIntelligenceEventsQueryKey,
  type IntelligenceEvent,
} from "@workspace/api-client-react";
import { useMyRole } from "@/lib/use-my-role";
import { toast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

// Poll the war-room feed at the same cadence as the EventStreamPane
// (#170). The two queries share an identical key so React Query
// dedupes the actual network request when both are mounted.
const WAR_ROOM_POLL_MS = 15_000;

// Severity threshold (1–10) that gates the global sidebar counter and
// the toast pop. Anything below this still shows up in the war-room
// itself but does not interrupt operators on other tabs — a power
// outage in a non-supplier region shouldn't trigger a toast.
const HIGH_SEVERITY_THRESHOLD = 7;

// How long the per-row "NEW" highlight lingers in the war-room before
// it fades back to normal styling. Kept in this module so the polling
// provider and the EventStreamPane agree on the decay window.
export const NEW_BADGE_LINGER_MS = 30_000;

// Same window we already pull in the EventStreamPane (last 72h, 200
// events) so React Query can dedupe and we don't issue a second
// request just to drive the global counter.
const QUERY_PARAMS = { hours: 72, limit: 200 } as const;

interface WarRoomAlertsState {
  /** Count of high-severity events that arrived while the operator
   *  was not viewing the War Room tab and have not been acknowledged. */
  unreadCount: number;
  /** Per-event-id timestamp of when we first saw the event in this
   *  session. Drives the row-level "NEW" badge inside EventStreamPane. */
  newSince: Map<string, number>;
  /** Acknowledge any pending unread alerts. Called when the operator
   *  opens the War Room tab, dismisses a toast, or clicks "Jump". */
  markAllSeen: () => void;
  /** EventStreamPane calls this on mount so arrivals while the user is
   *  actively watching the war room are absorbed silently — no point
   *  toasting a row they can already see. Returns a cleanup that
   *  releases the lock when the pane unmounts. */
  registerViewing: () => () => void;
}

const noopCleanup = () => {};

const WarRoomAlertsContext = createContext<WarRoomAlertsState>({
  unreadCount: 0,
  newSince: new Map(),
  markAllSeen: () => {},
  registerViewing: () => noopCleanup,
});

/**
 * Provider that polls the intelligence event stream at war-room cadence
 * and tracks which high-severity arrivals the operator has not yet
 * seen.  Wired up inside `App.tsx` just under `<ClerkProvider>` so the
 * Layout sidebar (badge) and Fusion page (NEW row highlight + toasts)
 * can share the same ground-truth seen-id set.
 *
 * Important behaviours:
 *  - The first payload after mount is silently absorbed — those events
 *    are *history*, not arrivals, so we never flash NEW or toast on
 *    initial load.
 *  - We only poll once the user is signed in. Anonymous visitors hit
 *    `/landing` etc. and would otherwise generate 401s on a 15s loop.
 *  - While `registerViewing` is held (EventStreamPane is mounted) we
 *    treat new arrivals as already-seen — no toast, no sidebar bump.
 */
export function WarRoomAlertsProvider({ children }: { children: ReactNode }) {
  const { isSignedIn } = useMyRole();
  const [unreadIds, setUnreadIds] = useState<Set<string>>(() => new Set());
  const [newSince, setNewSince] = useState<Map<string, number>>(
    () => new Map(),
  );
  const seenIdsRef = useRef<Set<string> | null>(null);
  // A counter rather than a boolean so two consumers (e.g. test
  // double-mount, future detail panes) can't race each other into a
  // false negative.
  const viewerCountRef = useRef(0);
  const [isViewing, setIsViewing] = useState(false);

  const { data, dataUpdatedAt } = useListIntelligenceEvents(QUERY_PARAMS, {
    query: {
      queryKey: getListIntelligenceEventsQueryKey(QUERY_PARAMS),
      refetchInterval: WAR_ROOM_POLL_MS,
      refetchOnWindowFocus: true,
      enabled: isSignedIn,
    },
  });

  const items = useMemo<IntelligenceEvent[]>(() => data?.items ?? [], [data]);

  const markAllSeen = useCallback(() => {
    setUnreadIds((prev) => (prev.size === 0 ? prev : new Set()));
  }, []);

  const registerViewing = useCallback(() => {
    viewerCountRef.current += 1;
    setIsViewing(true);
    // Opening the war room implicitly acknowledges everything queued
    // up while the operator was elsewhere.
    markAllSeen();
    return () => {
      viewerCountRef.current = Math.max(0, viewerCountRef.current - 1);
      if (viewerCountRef.current === 0) setIsViewing(false);
    };
  }, [markAllSeen]);

  // Diff arrivals vs the seen baseline whenever React Query writes a
  // fresh payload to the cache. We watch `dataUpdatedAt` rather than
  // `items` because the array reference changes on every render —
  // dataUpdatedAt only ticks on a real refresh.
  useEffect(() => {
    if (!data) return;
    const now = Date.now();
    if (seenIdsRef.current === null) {
      // First payload after sign-in: seed silently. Initial load is
      // history, not news.
      seenIdsRef.current = new Set(items.map((e) => e.id));
      return;
    }
    const seen = seenIdsRef.current;
    const arrivals: IntelligenceEvent[] = [];
    for (const e of items) {
      if (!seen.has(e.id)) {
        seen.add(e.id);
        arrivals.push(e);
      }
    }
    if (arrivals.length === 0) return;

    setNewSince((prev) => {
      const next = new Map(prev);
      for (const e of arrivals) next.set(e.id, now);
      return next;
    });

    // Anything sev>=threshold counts toward the sidebar badge and may
    // pop a toast. Lower-severity arrivals still get the NEW row
    // highlight inside the war room but don't interrupt other tabs.
    const highSev = arrivals.filter(
      (e) => (e.severity ?? 0) >= HIGH_SEVERITY_THRESHOLD,
    );
    if (highSev.length === 0) return;

    if (!isViewing) {
      setUnreadIds((prev) => {
        const next = new Set(prev);
        for (const e of highSev) next.add(e.id);
        return next;
      });
      // One toast per arrived high-sev event, capped at 3 per refresh
      // tick so a sudden burst doesn't bury the rest of the UI.
      for (const e of highSev.slice(0, 3)) {
        toast({
          variant: "destructive",
          title: `Severity ${e.severity ?? "?"} disruption · ${
            e.country ?? "global"
          }`,
          description: e.title ?? e.signalType,
          action: (
            <ToastAction
              altText="Jump to War Room"
              onClick={() => {
                markAllSeen();
                window.location.assign(`${basePath}/fusion?tab=events`);
              }}
            >
              Jump to War Room
            </ToastAction>
          ),
        });
      }
    }
    // dataUpdatedAt is the precise tick we want; including `items` and
    // friends would re-run the diff on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataUpdatedAt]);

  // When the user signs out we reset the baseline so the next sign-in
  // starts fresh rather than dumping a flood of "NEW" badges.
  useEffect(() => {
    if (isSignedIn) return;
    seenIdsRef.current = null;
    setUnreadIds((prev) => (prev.size === 0 ? prev : new Set()));
    setNewSince((prev) => (prev.size === 0 ? prev : new Map()));
  }, [isSignedIn]);

  // Decay the NEW badges past the linger window. Same shape as the
  // existing per-pane logic; lifted here so a row that arrives while
  // the operator is on Dashboard still fades correctly when they
  // eventually pivot to the war room.
  useEffect(() => {
    if (newSince.size === 0) return;
    const t = setInterval(() => {
      const cutoff = Date.now() - NEW_BADGE_LINGER_MS;
      setNewSince((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const [id, ts] of next) {
          if (ts < cutoff) {
            next.delete(id);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 5_000);
    return () => clearInterval(t);
  }, [newSince.size]);

  const value = useMemo<WarRoomAlertsState>(
    () => ({
      unreadCount: unreadIds.size,
      newSince,
      markAllSeen,
      registerViewing,
    }),
    [unreadIds, newSince, markAllSeen, registerViewing],
  );

  return (
    <WarRoomAlertsContext.Provider value={value}>
      {children}
    </WarRoomAlertsContext.Provider>
  );
}

export function useWarRoomAlerts(): WarRoomAlertsState {
  return useContext(WarRoomAlertsContext);
}
