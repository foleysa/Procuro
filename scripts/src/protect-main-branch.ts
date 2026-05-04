#!/usr/bin/env tsx

const REQUIRED_CHECKS = [
  "Unit tests for @workspace/scripts",
  "UAT bug fix requires regression test",
  "SAST scanning",
  "Dependency vulnerability scan",
  "Secret scanning",
  "WCAG 2.2 AA scan",
];
const BRANCH = "main";

export interface StatusCheck {
  strict: boolean;
  contexts: string[];
}

export interface BranchProtection {
  required_status_checks: StatusCheck | null;
  enforce_admins: { enabled: boolean } | null;
  required_pull_request_reviews: {
    dismiss_stale_reviews: boolean;
    require_code_owner_reviews: boolean;
    required_approving_review_count: number;
  } | null;
  restrictions: {
    users: Array<{ login: string }>;
    teams: Array<{ slug: string }>;
    apps: Array<{ slug: string }>;
  } | null;
  allow_force_pushes?: { enabled: boolean } | null;
  allow_deletions?: { enabled: boolean } | null;
  required_linear_history?: { enabled: boolean } | null;
  required_conversation_resolution?: { enabled: boolean } | null;
}

export interface ProtectionPayload {
  required_status_checks: { strict: boolean; contexts: string[] } | null;
  enforce_admins: boolean;
  required_pull_request_reviews: {
    dismiss_stale_reviews: boolean;
    require_code_owner_reviews: boolean;
    required_approving_review_count: number;
  } | null;
  restrictions: {
    users: string[];
    teams: string[];
    apps: string[];
  } | null;
  allow_force_pushes?: boolean;
  allow_deletions?: boolean;
  required_linear_history?: boolean;
  required_conversation_resolution?: boolean;
}

export function buildPayload(
  existing: BranchProtection | null,
  requiredChecks: string[]
): ProtectionPayload {
  const existingContexts =
    existing?.required_status_checks?.contexts ?? [];

  const contexts = [...existingContexts];
  for (const check of requiredChecks) {
    if (!contexts.includes(check)) {
      contexts.push(check);
    }
  }

  const requiredStatusChecks: ProtectionPayload["required_status_checks"] = {
    strict: existing?.required_status_checks?.strict ?? false,
    contexts,
  };

  const enforceAdmins = existing?.enforce_admins?.enabled ?? false;

  const prReviews = existing?.required_pull_request_reviews
    ? {
        dismiss_stale_reviews:
          existing.required_pull_request_reviews.dismiss_stale_reviews,
        require_code_owner_reviews:
          existing.required_pull_request_reviews.require_code_owner_reviews,
        required_approving_review_count:
          existing.required_pull_request_reviews
            .required_approving_review_count,
      }
    : null;

  const restrictions = existing?.restrictions
    ? {
        users: existing.restrictions.users.map((u) => u.login),
        teams: existing.restrictions.teams.map((t) => t.slug),
        apps: existing.restrictions.apps.map((a) => a.slug),
      }
    : null;

  const payload: ProtectionPayload = {
    required_status_checks: requiredStatusChecks,
    enforce_admins: enforceAdmins,
    required_pull_request_reviews: prReviews,
    restrictions,
  };

  if (existing?.allow_force_pushes != null) {
    payload.allow_force_pushes = existing.allow_force_pushes.enabled;
  }
  if (existing?.allow_deletions != null) {
    payload.allow_deletions = existing.allow_deletions.enabled;
  }
  if (existing?.required_linear_history != null) {
    payload.required_linear_history = existing.required_linear_history.enabled;
  }
  if (existing?.required_conversation_resolution != null) {
    payload.required_conversation_resolution =
      existing.required_conversation_resolution.enabled;
  }

  return payload;
}

async function fetchProtection(
  repo: string,
  branch: string,
  token: string
): Promise<BranchProtection | null> {
  const url = `https://api.github.com/repos/${repo}/branches/${branch}/protection`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (res.status === 404) {
    return null;
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET branch protection failed (${res.status}): ${text}`);
  }

  return (await res.json()) as BranchProtection;
}

async function applyProtection(
  repo: string,
  branch: string,
  token: string,
  payload: ProtectionPayload
): Promise<void> {
  const url = `https://api.github.com/repos/${repo}/branches/${branch}/protection`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PUT branch protection failed (${res.status}): ${text}`);
  }
}

async function run(): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;

  if (!token) {
    console.error(
      "Error: GITHUB_TOKEN is not set. An admin personal access token with repo scope is required."
    );
    process.exit(1);
  }

  if (!repo) {
    console.error(
      "Error: GITHUB_REPOSITORY is not set. Expected format: owner/repo"
    );
    process.exit(1);
  }

  console.log(`Repository : ${repo}`);
  console.log(`Branch     : ${BRANCH}`);
  console.log(`Required checks:`);
  for (const check of REQUIRED_CHECKS) {
    console.log(`  - ${check}`);
  }
  console.log();

  console.log("Fetching current branch protection settings...");
  let existing: BranchProtection | null;
  try {
    existing = await fetchProtection(repo, BRANCH, token);
  } catch (err) {
    console.error(`Failed to fetch protection: ${err}`);
    process.exit(1);
  }

  if (existing === null) {
    console.log("No existing branch protection found — creating from scratch.");
  } else {
    const current = existing.required_status_checks?.contexts ?? [];
    console.log(
      `Existing required status checks: ${current.length === 0 ? "(none)" : current.join(", ")}`
    );
    const missing = REQUIRED_CHECKS.filter((c) => !current.includes(c));
    if (missing.length === 0) {
      console.log(`\n✓ All required status checks are already configured.`);
      process.exit(0);
    }
  }

  const payload = buildPayload(existing, REQUIRED_CHECKS);

  console.log("Applying branch protection...");
  try {
    await applyProtection(repo, BRANCH, token, payload);
  } catch (err) {
    console.error(`Failed to apply protection: ${err}`);
    process.exit(1);
  }

  const finalContexts = payload.required_status_checks?.contexts ?? [];
  console.log(`\n✓ Branch protection updated successfully.`);
  console.log(`Required status checks: ${finalContexts.join(", ")}`);
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  new URL(import.meta.url).pathname === new URL(process.argv[1], "file:").pathname;

if (isMain) {
  run();
}
