/**
 * Route inventory for WCAG 2.2 AA accessibility scanning.
 *
 * Every public and authenticated route in the Command Center is listed here.
 * Add new routes to this file whenever a new page is introduced.
 * Parameterised routes use environment-variable overrides so CI can inject
 * real IDs from fixture data; they fall back to placeholder strings that
 * exercise the page skeleton even when no real ID is available.
 */

export type RouteEntry = {
  /** URL path, relative to the app base. */
  path: string;
  /** Human-readable name for reports. */
  name: string;
  /** Whether the route requires the dev-tenant header auth bypass. */
  requiresAuth: boolean;
  /** Short description of what this route shows. */
  description: string;
};

const opportunityId =
  process.env["A11Y_OPPORTUNITY_ID"] ?? "00000000-0000-0000-0000-000000000001";
const supplierId =
  process.env["A11Y_SUPPLIER_ID"] ?? "00000000-0000-0000-0000-000000000001";
const contractId =
  process.env["A11Y_CONTRACT_ID"] ?? "00000000-0000-0000-0000-000000000001";
const sowId =
  process.env["A11Y_SOW_ID"] ?? "00000000-0000-0000-0000-000000000001";
const rateCardId =
  process.env["A11Y_RATE_CARD_ID"] ?? "00000000-0000-0000-0000-000000000001";
const jobId =
  process.env["A11Y_JOB_ID"] ?? "00000000-0000-0000-0000-000000000001";

export const ROUTES: RouteEntry[] = [
  // ── Public routes (no auth required) ────────────────────────────────────
  {
    path: "/landing",
    name: "Landing",
    requiresAuth: false,
    description: "Marketing / product overview landing page",
  },
  {
    path: "/sign-in",
    name: "Sign In",
    requiresAuth: false,
    description: "Clerk-rendered sign-in page",
  },
  {
    path: "/sign-up",
    name: "Sign Up",
    requiresAuth: false,
    description: "Clerk-rendered sign-up page",
  },
  {
    path: "/trust/public",
    name: "Trust Center (public)",
    requiresAuth: false,
    description: "Public security & compliance trust center for procurement reviewers",
  },

  // ── Authenticated dashboard routes ───────────────────────────────────────
  {
    path: "/",
    name: "Home / Dashboard",
    requiresAuth: true,
    description: "Unified home and daily dashboard",
  },
  {
    path: "/spend",
    name: "Spend Overview",
    requiresAuth: true,
    description: "Spend analytics and category breakdown",
  },
  {
    path: "/suppliers",
    name: "Suppliers",
    requiresAuth: true,
    description: "Supplier directory and risk overview",
  },
  {
    path: `/suppliers/${supplierId}`,
    name: "Supplier Detail",
    requiresAuth: true,
    description: "Individual supplier profile and intelligence",
  },
  {
    path: "/opportunities",
    name: "Opportunities",
    requiresAuth: true,
    description: "AI-generated savings and negotiation opportunities",
  },
  {
    path: `/opportunities/${opportunityId}`,
    name: "Opportunity Detail",
    requiresAuth: true,
    description: "Individual opportunity detail and action panel",
  },
  {
    path: "/contracts",
    name: "Contracts",
    requiresAuth: true,
    description: "Contract register and renewal tracker",
  },
  {
    path: `/contracts/${contractId}`,
    name: "Contract Detail",
    requiresAuth: true,
    description: "Individual contract clauses and metadata",
  },
  {
    path: "/services",
    name: "Services",
    requiresAuth: true,
    description: "SOW and rate card service catalog",
  },
  {
    path: `/sows/${sowId}`,
    name: "SOW Detail",
    requiresAuth: true,
    description: "Statement of work detail view",
  },
  {
    path: `/rate-cards/${rateCardId}`,
    name: "Rate Card Detail",
    requiresAuth: true,
    description: "Rate card line items and comparison",
  },
  {
    path: "/approvals",
    name: "Approvals",
    requiresAuth: true,
    description: "Approval queue for procurement requests",
  },
  {
    path: "/fusion",
    name: "Intelligence (Fusion)",
    requiresAuth: true,
    description: "Real-time market intelligence and war-room feed",
  },
  {
    path: "/alerts",
    name: "Alerts",
    requiresAuth: true,
    description: "Notification and alert inbox",
  },
  {
    path: "/watchlists",
    name: "Saved Lists",
    requiresAuth: true,
    description: "User-curated watchlists",
  },
  {
    path: "/watched-companies",
    name: "Watched Companies",
    requiresAuth: true,
    description: "Global company monitoring (analyst+)",
  },
  {
    path: "/watched-us-suppliers",
    name: "Watched US Suppliers",
    requiresAuth: true,
    description: "US supplier monitoring via federal data sources",
  },
  {
    path: "/results",
    name: "Results & Billing",
    requiresAuth: true,
    description: "Realized savings and billing summary",
  },
  {
    path: "/playbook",
    name: "Playbook",
    requiresAuth: true,
    description: "Procurement strategy playbook and templates",
  },
  {
    path: "/trust",
    name: "Trust Center (authenticated)",
    requiresAuth: true,
    description: "Full trust center with audit log access",
  },
  {
    path: "/whats-new",
    name: "What's New",
    requiresAuth: true,
    description: "Changelog and release notes",
  },
  {
    path: "/settings",
    name: "Settings",
    requiresAuth: true,
    description: "User and workspace preferences",
  },

  // ── Operations / admin routes ────────────────────────────────────────────
  {
    path: "/operations",
    name: "Operations Health",
    requiresAuth: true,
    description: "Pipeline health and collector status (admin)",
  },
  {
    path: "/collectors",
    name: "Collectors",
    requiresAuth: true,
    description: "Data collector configuration and run history (admin)",
  },
  {
    path: "/data-sources",
    name: "Data Sources",
    requiresAuth: true,
    description: "Connected data source registry (admin)",
  },
  {
    path: "/ingest",
    name: "Data Ingest",
    requiresAuth: true,
    description: "Manual data ingestion and upload (analyst+)",
  },
  {
    path: "/integrations",
    name: "Integrations",
    requiresAuth: true,
    description: "Third-party integration management (admin)",
  },
  {
    path: "/system",
    name: "System & Jobs",
    requiresAuth: true,
    description: "Background job monitor and system health (admin)",
  },
  {
    path: `/system/jobs/${jobId}`,
    name: "Job Detail",
    requiresAuth: true,
    description: "Individual background job log and status",
  },
  {
    path: "/engine",
    name: "Engine",
    requiresAuth: true,
    description: "Procurement pipeline controls (admin)",
  },
  {
    path: "/admin/taxonomy/queue",
    name: "Taxonomy Queue",
    requiresAuth: true,
    description: "Category taxonomy mapping queue (admin)",
  },
  {
    path: "/admin/a11y",
    name: "A11y Trends",
    requiresAuth: true,
    description: "Accessibility violation trend reporting (platform admin)",
  },
  {
    path: "/admin",
    name: "Org Admin",
    requiresAuth: true,
    description: "Member management, roles, and API keys (admin)",
  },
];
