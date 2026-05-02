/**
 * Heuristic mapping from rate-card role labels to BLS OEWS SOC codes /
 * scope-category codes — the vocabulary used by the
 * `wage_benchmark` market signals emitted by the OEWS collector
 * (`bls-oews.ts`).
 *
 * Rate cards are author-supplied free text ("Senior Software Engineer
 * III", "Principal Consultant", "Tax Manager"). They do not carry SOC
 * codes. To benchmark a card against external wage signals we need to
 * land each role string on one of the curated SOC occupations the
 * collector publishes — anything that doesn't match returns `null`
 * and the analyzer skips that line rather than fabricating a benchmark.
 *
 * The keyword list intentionally biases toward precision: a vague role
 * label ("Manager", "Director") yields no match because it's not safe
 * to anchor a market wage to a generic management title. Add entries
 * conservatively as new rate cards surface.
 */

export interface RoleSocMatch {
  /** Canonical scope-category code shared with `wage_benchmark` signals. */
  scopeCategoryCode: string;
  /** SOC code with hyphen ("13-1111"). Surfaced on the opportunity for audit. */
  socCode: string;
  /** Human-readable OEWS occupation label (matches `OEWS_OCCUPATIONS`). */
  label: string;
}

interface RoleMap extends RoleSocMatch {
  /** Lower-case substring tokens — first match wins, in declared order. */
  keywords: string[];
}

const ROLE_TO_SCOPE_CATEGORY: RoleMap[] = [
  {
    keywords: ["lawyer", "attorney", "counsel", "paralegal"],
    scopeCategoryCode: "PROF_LEGAL",
    socCode: "23-1011",
    label: "Lawyers",
  },
  {
    keywords: [
      "accountant",
      "auditor",
      "tax preparer",
      "tax associate",
      "tax manager",
      "tax senior",
    ],
    scopeCategoryCode: "PROF_AUDIT_TAX",
    socCode: "13-2011",
    label: "Accountants and Auditors",
  },
  {
    keywords: [
      "consultant",
      "management analyst",
      "strategy",
      "principal advisor",
      "engagement manager",
    ],
    scopeCategoryCode: "PROF_CONSULTING_OPS",
    socCode: "13-1111",
    label: "Management Analysts",
  },
  {
    keywords: [
      "software engineer",
      "software developer",
      "swe",
      "full stack",
      "frontend",
      "backend",
      "application engineer",
      "ios engineer",
      "android engineer",
    ],
    scopeCategoryCode: "IT_APP_DEV",
    socCode: "15-1252",
    label: "Software Developers",
  },
  {
    keywords: [
      "network engineer",
      "sysadmin",
      "system administrator",
      "infrastructure engineer",
      "devops",
      "sre",
      "site reliability",
      "cloud engineer",
    ],
    scopeCategoryCode: "IT_INFRA",
    socCode: "15-1244",
    label: "Network and Computer Systems Administrators",
  },
  {
    keywords: [
      "it project manager",
      "it pm",
      "managed service",
      "technical project manager",
      "technical pm",
      "delivery manager",
    ],
    scopeCategoryCode: "IT_MANAGED_SERVICES",
    socCode: "15-1299",
    label: "Computer Occupations, All Other",
  },
  {
    keywords: [
      "designer",
      "graphic",
      "creative director",
      "art director",
      "copywriter",
      "ux designer",
      "ui designer",
    ],
    scopeCategoryCode: "MKT_AGENCY_CREATIVE",
    socCode: "27-1024",
    label: "Graphic Designers",
  },
  {
    keywords: [
      "recruiter",
      "hr specialist",
      "talent acquisition",
      "people partner",
      "human resources",
    ],
    scopeCategoryCode: "HR_RECRUITING",
    socCode: "13-1071",
    label: "Human Resources Specialists",
  },
  {
    keywords: ["security guard", "security officer"],
    scopeCategoryCode: "FAC_SECURITY",
    socCode: "33-9032",
    label: "Security Guards",
  },
  {
    keywords: ["janitor", "cleaner", "custodian"],
    scopeCategoryCode: "FAC_JANITORIAL",
    socCode: "37-2011",
    label: "Janitors and Cleaners",
  },
  {
    keywords: [
      "mechanical engineer",
      "electrical engineer",
      "research engineer",
      "r&d engineer",
      "rd engineer",
    ],
    scopeCategoryCode: "ENG_RND",
    socCode: "17-2199",
    label: "Engineers, All Other",
  },
];

/** First-match heuristic. Returns `null` when no curated keyword fires. */
export function mapRoleToScopeCategory(role: string): RoleSocMatch | null {
  if (!role) return null;
  const r = role.toLowerCase();
  for (const m of ROLE_TO_SCOPE_CATEGORY) {
    if (m.keywords.some((k) => r.includes(k))) {
      return {
        scopeCategoryCode: m.scopeCategoryCode,
        socCode: m.socCode,
        label: m.label,
      };
    }
  }
  return null;
}

/** Distinct list of scope-category codes the role mapper can emit. */
export const ROLE_SCOPE_CATEGORY_CODES: readonly string[] = Array.from(
  new Set(ROLE_TO_SCOPE_CATEGORY.map((m) => m.scopeCategoryCode)),
);
