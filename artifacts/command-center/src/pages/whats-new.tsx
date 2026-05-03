import { Link } from "wouter";

/**
 * #199 — Old→new IA mapping.
 *
 * Reachable from the migration banner so deep-links and bookmarks have
 * a single place to confirm where their old page now lives. Kept as a
 * plain table — no querying, no role gating; the destinations
 * themselves enforce their own access.
 */
type Move = { from: string; to: string; note?: string };

const MOVES: Move[] = [
  { from: "/dashboard", to: "/", note: "Today and Dashboard merged into one unified landing page at /." },
  { from: "/today", to: "/", note: "Today and Dashboard merged into one unified landing page at /." },
  {
    from: "/admin/funnel",
    to: "/engine",
    note: "Friendlier name; same admin gating.",
  },
  {
    from: "Sidebar (flat)",
    to: "Sidebar (grouped)",
    note: "Today / Workspace / Intelligence / Operations / Engine / Org.",
  },
  {
    from: "System health (scattered)",
    to: "/operations",
    note: "Single admin-only health surface.",
  },
];

export default function WhatsNew() {
  return (
    <div className="p-8 max-w-3xl">
      <h1 className="text-2xl font-bold tracking-tight">What moved</h1>
      <p className="text-sm text-muted-foreground mt-1">
        Quick reference for the navigation change shipped with the IA
        redesign.
      </p>

      <table className="mt-6 w-full text-sm border-collapse">
        <thead className="text-left text-xs uppercase text-muted-foreground">
          <tr>
            <th className="py-2 pr-4 border-b">From</th>
            <th className="py-2 pr-4 border-b">To</th>
            <th className="py-2 border-b">Note</th>
          </tr>
        </thead>
        <tbody>
          {MOVES.map((m) => (
            <tr key={`${m.from}->${m.to}`} className="border-b last:border-b-0">
              <td className="py-2 pr-4 font-mono text-xs">{m.from}</td>
              <td className="py-2 pr-4 font-mono text-xs">
                {m.to.startsWith("/") ? (
                  <Link href={m.to} className="underline">
                    {m.to}
                  </Link>
                ) : (
                  m.to
                )}
              </td>
              <td className="py-2 text-muted-foreground">{m.note ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="text-xs text-muted-foreground mt-6">
        Old links continue to work via redirects. This page exists so you
        can confirm where to look without guessing.
      </p>
    </div>
  );
}
