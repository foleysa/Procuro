/**
 * Engine — friendlier home for the funnel substrate observability
 * surface (#185, re-hosted by #199 step 6).
 *
 * Page internals are re-hosted, not rewritten — the existing
 * AdminFunnel implementation is the engine page. The friendlier path
 * `/engine` is committed in `docs/command-center-ia.md`. The legacy
 * `/admin/funnel` URL still resolves via a redirect for bookmark
 * stability (App.tsx).
 */
import AdminFunnel from "./admin-funnel";

export default function Engine() {
  return <AdminFunnel />;
}
