import { describe, it, expect } from "vitest";
import { buildPayload, type BranchProtection } from "./protect-main-branch.js";

const UNIT_TEST_CHECK = "Unit tests for @workspace/scripts";

const ALL_REQUIRED_CHECKS = [
  "Unit tests for @workspace/scripts",
  "UAT bug fix requires regression test",
  "SAST scanning",
  "Dependency vulnerability scan",
  "Secret scanning",
  "WCAG 2.2 AA scan",
];

describe("buildPayload", () => {
  it("adds all required checks when no protection exists", () => {
    const payload = buildPayload(null, ALL_REQUIRED_CHECKS);

    expect(payload.required_status_checks).not.toBeNull();
    for (const check of ALL_REQUIRED_CHECKS) {
      expect(payload.required_status_checks!.contexts).toContain(check);
    }
  });

  it("includes every required CI check in the contexts list", () => {
    const payload = buildPayload(null, ALL_REQUIRED_CHECKS);

    const contexts = payload.required_status_checks!.contexts;
    expect(contexts).toContain("Unit tests for @workspace/scripts");
    expect(contexts).toContain("UAT bug fix requires regression test");
    expect(contexts).toContain("SAST scanning");
    expect(contexts).toContain("Dependency vulnerability scan");
    expect(contexts).toContain("Secret scanning");
    expect(contexts).toContain("WCAG 2.2 AA scan");
  });

  it("preserves existing required status checks when adding new ones", () => {
    const existing: BranchProtection = {
      required_status_checks: {
        strict: true,
        contexts: ["lint", "typecheck"],
      },
      enforce_admins: { enabled: true },
      required_pull_request_reviews: null,
      restrictions: null,
    };

    const payload = buildPayload(existing, ALL_REQUIRED_CHECKS);

    const contexts = payload.required_status_checks!.contexts;
    expect(contexts).toContain("lint");
    expect(contexts).toContain("typecheck");
    for (const check of ALL_REQUIRED_CHECKS) {
      expect(contexts).toContain(check);
    }
    expect(payload.required_status_checks!.strict).toBe(true);
  });

  it("does not duplicate checks that are already present", () => {
    const existing: BranchProtection = {
      required_status_checks: {
        strict: false,
        contexts: [...ALL_REQUIRED_CHECKS, "lint"],
      },
      enforce_admins: null,
      required_pull_request_reviews: null,
      restrictions: null,
    };

    const payload = buildPayload(existing, ALL_REQUIRED_CHECKS);

    for (const check of ALL_REQUIRED_CHECKS) {
      const count = payload.required_status_checks!.contexts.filter(
        (c) => c === check
      ).length;
      expect(count).toBe(1);
    }
  });

  it("does not duplicate a partially-overlapping check set", () => {
    const existing: BranchProtection = {
      required_status_checks: {
        strict: false,
        contexts: [UNIT_TEST_CHECK, "SAST scanning"],
      },
      enforce_admins: null,
      required_pull_request_reviews: null,
      restrictions: null,
    };

    const payload = buildPayload(existing, ALL_REQUIRED_CHECKS);

    const contexts = payload.required_status_checks!.contexts;
    expect(contexts.filter((c) => c === UNIT_TEST_CHECK).length).toBe(1);
    expect(contexts.filter((c) => c === "SAST scanning").length).toBe(1);
    expect(contexts).toContain("UAT bug fix requires regression test");
    expect(contexts).toContain("Dependency vulnerability scan");
    expect(contexts).toContain("Secret scanning");
    expect(contexts).toContain("WCAG 2.2 AA scan");
  });

  it("works with a single-element array", () => {
    const payload = buildPayload(null, [UNIT_TEST_CHECK]);

    expect(payload.required_status_checks!.contexts).toContain(UNIT_TEST_CHECK);
    expect(payload.required_status_checks!.contexts).toHaveLength(1);
  });

  it("preserves enforce_admins setting", () => {
    const existing: BranchProtection = {
      required_status_checks: null,
      enforce_admins: { enabled: true },
      required_pull_request_reviews: null,
      restrictions: null,
    };

    const payload = buildPayload(existing, ALL_REQUIRED_CHECKS);
    expect(payload.enforce_admins).toBe(true);
  });

  it("defaults enforce_admins to false when no existing protection", () => {
    const payload = buildPayload(null, ALL_REQUIRED_CHECKS);
    expect(payload.enforce_admins).toBe(false);
  });

  it("preserves pull request review settings", () => {
    const existing: BranchProtection = {
      required_status_checks: null,
      enforce_admins: null,
      required_pull_request_reviews: {
        dismiss_stale_reviews: true,
        require_code_owner_reviews: false,
        required_approving_review_count: 2,
      },
      restrictions: null,
    };

    const payload = buildPayload(existing, ALL_REQUIRED_CHECKS);

    expect(payload.required_pull_request_reviews).not.toBeNull();
    expect(payload.required_pull_request_reviews!.dismiss_stale_reviews).toBe(true);
    expect(payload.required_pull_request_reviews!.required_approving_review_count).toBe(2);
  });

  it("preserves restrictions as login/slug strings", () => {
    const existing: BranchProtection = {
      required_status_checks: null,
      enforce_admins: null,
      required_pull_request_reviews: null,
      restrictions: {
        users: [{ login: "alice" }],
        teams: [{ slug: "backend" }],
        apps: [{ slug: "my-app" }],
      },
    };

    const payload = buildPayload(existing, ALL_REQUIRED_CHECKS);

    expect(payload.restrictions).not.toBeNull();
    expect(payload.restrictions!.users).toEqual(["alice"]);
    expect(payload.restrictions!.teams).toEqual(["backend"]);
    expect(payload.restrictions!.apps).toEqual(["my-app"]);
  });

  it("preserves allow_force_pushes when present", () => {
    const existing: BranchProtection = {
      required_status_checks: null,
      enforce_admins: null,
      required_pull_request_reviews: null,
      restrictions: null,
      allow_force_pushes: { enabled: false },
    };

    const payload = buildPayload(existing, ALL_REQUIRED_CHECKS);
    expect(payload.allow_force_pushes).toBe(false);
  });

  it("preserves allow_deletions when present", () => {
    const existing: BranchProtection = {
      required_status_checks: null,
      enforce_admins: null,
      required_pull_request_reviews: null,
      restrictions: null,
      allow_deletions: { enabled: true },
    };

    const payload = buildPayload(existing, ALL_REQUIRED_CHECKS);
    expect(payload.allow_deletions).toBe(true);
  });

  it("preserves required_linear_history when present", () => {
    const existing: BranchProtection = {
      required_status_checks: null,
      enforce_admins: null,
      required_pull_request_reviews: null,
      restrictions: null,
      required_linear_history: { enabled: true },
    };

    const payload = buildPayload(existing, ALL_REQUIRED_CHECKS);
    expect(payload.required_linear_history).toBe(true);
  });

  it("preserves required_conversation_resolution when present", () => {
    const existing: BranchProtection = {
      required_status_checks: null,
      enforce_admins: null,
      required_pull_request_reviews: null,
      restrictions: null,
      required_conversation_resolution: { enabled: true },
    };

    const payload = buildPayload(existing, ALL_REQUIRED_CHECKS);
    expect(payload.required_conversation_resolution).toBe(true);
  });

  it("does not include optional fields when they are absent from existing protection", () => {
    const existing: BranchProtection = {
      required_status_checks: null,
      enforce_admins: null,
      required_pull_request_reviews: null,
      restrictions: null,
    };

    const payload = buildPayload(existing, ALL_REQUIRED_CHECKS);

    expect(payload).not.toHaveProperty("allow_force_pushes");
    expect(payload).not.toHaveProperty("allow_deletions");
    expect(payload).not.toHaveProperty("required_linear_history");
    expect(payload).not.toHaveProperty("required_conversation_resolution");
  });
});
