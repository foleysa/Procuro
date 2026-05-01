/**
 * `/admin/taxonomy/queue` — operator surface for resolving the
 * unmapped-category queue (task #213).
 *
 * The spec puts this surface on its own path under the Engine section
 * rather than burying it inside the funnel observability tabs. The
 * heavy lifting (queue table, mapping dropdowns, scope toggle, and
 * collision-decision dialog) lives in the shared `RoutingQueueTab`
 * component and is re-used here verbatim — the only difference is the
 * page-level chrome (title + intro). The funnel observability page
 * still embeds the same component as a tab for operators who reach it
 * from the funnel breakdown.
 */
import { RoutingQueueTab } from "./admin-funnel";

export default function TaxonomyQueue() {
  return (
    <div className="container mx-auto p-6 space-y-6" data-testid="page-taxonomy-queue">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">
          Taxonomy queue
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Tenant-supplied category strings that didn't match any
          existing synonym. Map each one to a canonical code; the
          synonym registry is append-only, and existing opportunities
          are audit-flagged rather than rewritten so calibration data
          stays clean.
        </p>
      </div>
      <RoutingQueueTab />
    </div>
  );
}
