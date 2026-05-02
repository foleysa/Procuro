import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  BarChart3,
  Sparkles,
  FileText,
  CheckSquare,
  TrendingUp,
  BookOpen,
  Building2,
  Radar,
  Server,
  Workflow,
  Upload,
  Database,
  Plug,
  Settings,
  ShieldCheck,
  Eye,
  Atom,
  Shield,
  Bell,
  Sun,
  Activity,
  Cpu,
  Bookmark,
  Tag,
  Wrench,
} from "lucide-react";
import { Show, useClerk, useUser } from "@clerk/react";
import { OrgSwitcher } from "./org-switcher";
import { cn } from "@/lib/utils";
import { useMyRole } from "@/lib/use-my-role";
import type { AdminUserRole } from "@/lib/admin-client";
import { Button } from "@/components/ui/button";
import { MigrationBanner } from "./migration-banner";

interface LayoutProps {
  children: React.ReactNode;
}

type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Minimum role required to see this item; omit = visible to any signed-in role. */
  minRole?: AdminUserRole;
  /** Visible to signed-out users too (default false). */
  anonymous?: boolean;
};

type NavGroup = {
  id: string;
  label: string;
  items: NavItem[];
};

/**
 * Sidebar IA per docs/command-center-ia.md (#199). Items are grouped
 * into the five user journeys; rendering filters items by the resolved
 * role from `/api/admin/whoami`. Order matters and is the source of
 * truth for the operator's visual mental model.
 */
const NAV_GROUPS: NavGroup[] = [
  {
    id: "today",
    label: "Today",
    items: [{ href: "/", label: "Today", icon: Sun }],
  },
  {
    id: "workspace",
    label: "Workspace",
    items: [
      { href: "/spend", label: "Spend Overview", icon: BarChart3 },
      { href: "/suppliers", label: "Suppliers", icon: Building2 },
      { href: "/contracts", label: "Contracts", icon: FileText },
      { href: "/services", label: "Services", icon: Wrench },
      { href: "/approvals", label: "Approvals", icon: CheckSquare, minRole: "approver" },
    ],
  },
  {
    id: "intelligence",
    label: "Intelligence",
    items: [
      { href: "/fusion", label: "Intelligence", icon: Atom },
      { href: "/opportunities", label: "Opportunities", icon: Sparkles },
      { href: "/alerts", label: "Alerts", icon: Bell },
      { href: "/watchlists", label: "Saved Lists", icon: Bookmark },
      { href: "/watched-companies", label: "Watched Companies", icon: Eye, minRole: "analyst" },
    ],
  },
  {
    id: "operations",
    label: "Operations",
    items: [
      { href: "/operations", label: "Operations Health", icon: Activity, minRole: "org_admin" },
      { href: "/collectors", label: "Collectors", icon: Radar, minRole: "org_admin" },
      { href: "/data-sources", label: "Data Sources", icon: Database, minRole: "org_admin" },
      { href: "/ingest", label: "Data Ingest", icon: Upload, minRole: "analyst" },
      { href: "/integrations", label: "Integrations", icon: Plug, minRole: "org_admin" },
      { href: "/system", label: "System & Jobs", icon: Server, minRole: "org_admin" },
    ],
  },
  {
    id: "engine",
    label: "Engine",
    items: [
      { href: "/engine", label: "Engine", icon: Cpu, minRole: "org_admin" },
      { href: "/admin/taxonomy/queue", label: "Taxonomy Queue", icon: Tag, minRole: "org_admin" },
    ],
  },
  {
    id: "org",
    label: "Org",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { href: "/results", label: "Results & Billing", icon: TrendingUp },
      { href: "/playbook", label: "Playbook", icon: BookOpen },
      { href: "/trust", label: "Trust Center", icon: Shield },
      { href: "/settings", label: "Settings", icon: Settings },
      { href: "/admin", label: "Org Admin", icon: ShieldCheck, minRole: "org_admin" },
    ],
  },
];

export function Layout({ children }: LayoutProps) {
  const [location] = useLocation();
  const { hasRole, isSignedIn } = useMyRole();
  const { user } = useUser();
  const { signOut } = useClerk();

  const visibleGroups = NAV_GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((item) => {
      if (item.minRole) return hasRole(item.minRole);
      // Default: visible to any signed-in role; signed-out users see only
      // items explicitly marked anonymous (none today).
      if (item.anonymous) return true;
      return isSignedIn;
    }),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="flex min-h-screen bg-background">
      <aside className="w-64 border-r bg-sidebar flex-shrink-0 flex flex-col">
        <div className="p-4 border-b border-sidebar-border">
          <Link
            href="/landing"
            className="flex items-center gap-2 mb-6 px-2 text-sidebar-foreground font-bold"
          >
            <Workflow className="w-5 h-5 text-sidebar-primary" />
            <span>Procuro</span>
          </Link>
          <OrgSwitcher />
        </div>
        <nav className="flex-1 p-4 space-y-4 overflow-y-auto">
          {visibleGroups.map((group) => (
            <div key={group.id} data-testid={`nav-group-${group.id}`}>
              <div className="px-3 mb-1 text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground/50">
                {group.label}
              </div>
              <div className="space-y-0.5">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const isActive =
                    location === item.href ||
                    (item.href !== "/" && location.startsWith(item.href));
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      data-testid={`nav-${item.href.slice(1) || "today"}`}
                      className={cn(
                        "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors",
                        isActive
                          ? "bg-sidebar-primary text-sidebar-primary-foreground"
                          : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                      )}
                    >
                      <Icon className="w-4 h-4" />
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
        <div className="p-4 border-t border-sidebar-border">
          <p className="text-xs text-sidebar-foreground/60">
            Procurement‑as‑a‑Service
          </p>
          <p className="text-xs text-sidebar-foreground/40 mt-1">v0.1 MVP</p>
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0">
        <header className="h-14 border-b bg-card flex items-center justify-between px-8 flex-shrink-0">
          <span className="text-sm font-medium text-muted-foreground">
            Command Center
          </span>
          <div className="flex items-center gap-4">
            <Link
              href="/landing"
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              What is Procuro? →
            </Link>
            <Show when="signed-in">
              <span
                data-testid="text-user-email"
                className="text-xs text-muted-foreground hidden sm:inline"
              >
                {user?.primaryEmailAddress?.emailAddress ?? user?.id ?? ""}
              </span>
              <Button
                size="sm"
                variant="ghost"
                data-testid="button-sign-out"
                onClick={() => void signOut()}
              >
                Sign out
              </Button>
            </Show>
            <Show when="signed-out">
              <Link
                href="/sign-in"
                data-testid="link-header-sign-in"
                className="text-xs font-medium text-primary hover:underline"
              >
                Sign in
              </Link>
            </Show>
          </div>
        </header>
        <MigrationBanner />
        <div className="flex-1 overflow-y-auto">{children}</div>
      </main>
    </div>
  );
}
