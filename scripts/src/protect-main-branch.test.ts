import { describe, it, expect } from "vitest";
import { buildPayload, type BranchProtection } from "./protect-main-branch.js";

const REQUIRED_CHECK = "Unit tests for @workspace/scripts";

describe("buildPayload", () => {
  it("adds the required check when no protection exists", () => {
    const payload = buildPayload(null, REQUIRED_CHECK);

    expect(payload.required_status_checks).not.toBeNull();
    expect(payload.required_status_checks!.contexts).toContain(REQUIRED_CHECK);
  });

  it("preserves existing required status checks when adding the new one", () => {
    const existing: BranchProtection = {
      required_status_checks: {
        strict: true,
        contexts: ["lint", "typecheck"],
      },
      enforce_admins: { enabled: true },
      required_pull_request_reviews: null,
      restrictions: null,
    };

    const payload = buildPayload(existing, REQUIRED_CHECK);

    expect(payload.required_status_checks!.contexts).toContain("lint");
    expect(payload.required_status_checks!.contexts).toContain("typecheck");
    expect(payload.required_status_checks!.contexts).toContain(REQUIRED_CHECK);
    expect(payload.required_status_checks!.strict).toBe(true);
  });

  it("does not duplicate the required check if it is already present", () => {
    const existing: BranchProtection = {
      required_status_checks: {
        strict: false,
        contexts: [REQUIRED_CHECK, "lint"],
      },
      enforce_admins: null,
      required_pull_request_reviews: null,
      restrictions: null,
    };

    const payload = buildPayload(existing, REQUIRED_CHECK);

    const count = payload.required_status_checks!.contexts.filter(
      (c) => c === REQUIRED_CHECK
    ).length;
    expect(count).toBe(1);
  });

  it("preserves enforce_admins setting", () => {
    const existing: BranchProtection = {
      required_status_checks: null,
      enforce_admins: { enabled: true },
      required_pull_request_reviews: null,
      restrictions: null,
    };

    const payload = buildPayload(existing, REQUIRED_CHECK);
    expect(payload.enforce_admins).toBe(true);
  });

  it("defaults enforce_admins to false when no existing protection", () => {
    const payload = buildPayload(null, REQUIRED_CHECK);
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

    const payload = buildPayload(existing, REQUIRED_CHECK);

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

    const payload = buildPayload(existing, REQUIRED_CHECK);

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

    const payload = buildPayload(existing, REQUIRED_CHECK);
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

    const payload = buildPayload(existing, REQUIRED_CHECK);
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

    const payload = buildPayload(existing, REQUIRED_CHECK);
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

    const payload = buildPayload(existing, REQUIRED_CHECK);
    expect(payload.required_conversation_resolution).toBe(true);
  });

  it("does not include optional fields when they are absent from existing protection", () => {
    const existing: BranchProtection = {
      required_status_checks: null,
      enforce_admins: null,
      required_pull_request_reviews: null,
      restrictions: null,
    };

    const payload = buildPayload(existing, REQUIRED_CHECK);

    expect(payload).not.toHaveProperty("allow_force_pushes");
    expect(payload).not.toHaveProperty("allow_deletions");
    expect(payload).not.toHaveProperty("required_linear_history");
    expect(payload).not.toHaveProperty("required_conversation_resolution");
  });
});
