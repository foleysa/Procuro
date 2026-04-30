import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  Sparkles,
  CheckSquare,
  Activity,
  TrendingUp,
  BookOpen,
  Radar,
  Server,
  Workflow,
  Upload,
} from "lucide-react";
import { OrgSwitcher } from "./org-switcher";
import { cn } from "@/lib/utils";

interface LayoutProps {
  children: React.ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const [location] = useLocation();

  const navItems = [
    { href: "/", label: "Spend Overview", icon: LayoutDashboard },
    { href: "/opportunities", label: "Opportunities", icon: Sparkles },
    { href: "/approvals", label: "Approvals", icon: CheckSquare },
    { href: "/ooda", label: "OODA Wheel", icon: Activity },
    { href: "/results", label: "Results & Billing", icon: TrendingUp },
    { href: "/playbook", label: "Playbook", icon: BookOpen },
    { href: "/collectors", label: "Collectors", icon: Radar },
    { href: "/system", label: "System / Jobs", icon: Server },
    { href: "/ingest", label: "Data Ingest", icon: Upload },
  ];

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
        <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive =
              location === item.href ||
              (item.href !== "/" && location.startsWith(item.href));
            return (
              <Link
                key={item.href}
                href={item.href}
                data-testid={`nav-${item.href.slice(1) || "dashboard"}`}
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
          <Link
            href="/landing"
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            What is Procuro? →
          </Link>
        </header>
        <div className="flex-1 overflow-y-auto">{children}</div>
      </main>
    </div>
  );
}
