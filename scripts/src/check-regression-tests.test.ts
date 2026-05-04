import { describe, it, expect, vi } from "vitest";
import {
  extractUatIds,
  extractClosingIssueNumbers,
  fetchLinkedIssueUatIds,
  findNewTestFiles,
  hasExceptionBypass,
  EXCEPTION_MARKER,
  EXCEPTION_LABEL,
  type PrInfo,
} from "./check-regression-tests.js";

function makePr(overrides: Partial<PrInfo> = {}): PrInfo {
  return {
    title: "",
    body: "",
    branchName: "",
    changedFiles: [],
    labels: [],
    ...overrides,
  };
}

function makeOkResponse(body: object): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

function makeErrorResponse(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => ({}),
  } as unknown as Response;
}

describe("extractUatIds", () => {
  it("returns empty array when PR has no UAT references", () => {
    const pr = makePr({ title: "Fix typo", body: "Small cleanup", branchName: "fix/typo" });
    expect(extractUatIds(pr)).toEqual([]);
  });

  it("detects UAT ID in PR title", () => {
    const pr = makePr({ title: "Fix UAT-2024-001 broken button" });
    const ids = extractUatIds(pr);
    expect(ids).toContain("UAT-2024-001");
  });

  it("detects UAT ID in PR body", () => {
    const pr = makePr({ body: "Closes UAT-2025-0042 regression in checkout" });
    const ids = extractUatIds(pr);
    expect(ids).toContain("UAT-2025-0042");
  });

  it("detects UAT ID in branch name", () => {
    const pr = makePr({ branchName: "fix/UAT-2023-99-login-crash" });
    const ids = extractUatIds(pr);
    expect(ids).toContain("UAT-2023-99");
  });

  it("normalises IDs to uppercase", () => {
    const pr = makePr({ title: "fix uat-2024-001 issue" });
    const ids = extractUatIds(pr);
    expect(ids).toContain("UAT-2024-001");
  });

  it("deduplicates the same ID appearing in title and body", () => {
    const pr = makePr({ title: "UAT-2024-001 fix", body: "Fixes UAT-2024-001" });
    const ids = extractUatIds(pr);
    expect(ids.filter((id) => id === "UAT-2024-001")).toHaveLength(1);
  });
});

describe("extractClosingIssueNumbers", () => {
  it("returns empty array for body without closing keywords", () => {
    expect(extractClosingIssueNumbers("Just a description")).toEqual([]);
  });

  it("extracts issue number from 'closes #123'", () => {
    expect(extractClosingIssueNumbers("closes #123")).toContain(123);
  });

  it("extracts issue number from 'fixes #456'", () => {
    expect(extractClosingIssueNumbers("Fixes #456")).toContain(456);
  });

  it("extracts issue number from 'resolves #789'", () => {
    expect(extractClosingIssueNumbers("Resolves #789")).toContain(789);
  });

  it("extracts multiple issue numbers", () => {
    const nums = extractClosingIssueNumbers("Closes #10, fixes #20, resolves #30");
    expect(nums).toEqual(expect.arrayContaining([10, 20, 30]));
  });
});

describe("fetchLinkedIssueUatIds", () => {
  it("returns empty array when PR body has no closing refs", async () => {
    const mockFetch = vi.fn();
    const ids = await fetchLinkedIssueUatIds("No closing refs here", "", "tok", "org/repo", mockFetch);
    expect(ids).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns UAT IDs found in linked issue title", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeOkResponse({ title: "UAT-2024-007 login crash", labels: [] })
    );
    const ids = await fetchLinkedIssueUatIds("Closes #42", "", "tok", "org/repo", mockFetch);
    expect(ids).toContain("UAT-2024-007");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/org/repo/issues/42",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer tok" }) })
    );
  });

  it("returns synthetic ID when linked issue has a UAT label", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeOkResponse({ title: "Some unrelated title", labels: [{ name: "UAT" }] })
    );
    const ids = await fetchLinkedIssueUatIds("Closes #99", "", "tok", "org/repo", mockFetch);
    expect(ids).toContain("#99");
  });

  it("skips issue gracefully when GitHub API returns a non-OK status", async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeErrorResponse(404));
    const ids = await fetchLinkedIssueUatIds("Closes #55", "", "tok", "org/repo", mockFetch);
    expect(ids).toEqual([]);
  });

  it("skips issue gracefully when fetch throws a network error", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Network failure"));
    const ids = await fetchLinkedIssueUatIds("Closes #77", "", "tok", "org/repo", mockFetch);
    expect(ids).toEqual([]);
  });

  it("handles multiple closing refs and accumulates UAT IDs from all", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(makeOkResponse({ title: "UAT-2024-001 issue", labels: [] }))
      .mockResolvedValueOnce(makeOkResponse({ title: "Unrelated", labels: [{ name: "uat-bug" }] }));
    const ids = await fetchLinkedIssueUatIds("Closes #1, fixes #2", "", "tok", "org/repo", mockFetch);
    expect(ids).toContain("UAT-2024-001");
    expect(ids).toContain("#2");
  });

  it("finds closing refs in commitMessages when prBody has none", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeOkResponse({ title: "UAT-2024-099 issue from commit", labels: [] })
    );
    const ids = await fetchLinkedIssueUatIds("", "Closes #100", "tok", "org/repo", mockFetch);
    expect(ids).toContain("UAT-2024-099");
  });
});

describe("findNewTestFiles", () => {
  it("returns empty array when no changed files match test patterns", () => {
    expect(findNewTestFiles(["src/index.ts", "README.md"])).toEqual([]);
  });

  it("detects .test.ts files", () => {
    const files = ["src/foo.test.ts"];
    expect(findNewTestFiles(files)).toEqual(["src/foo.test.ts"]);
  });

  it("detects .test.tsx files", () => {
    expect(findNewTestFiles(["src/Bar.test.tsx"])).toContain("src/Bar.test.tsx");
  });

  it("detects .spec.ts files", () => {
    expect(findNewTestFiles(["src/baz.spec.ts"])).toContain("src/baz.spec.ts");
  });

  it("detects .e2e.ts files", () => {
    expect(findNewTestFiles(["e2e/login.e2e.ts"])).toContain("e2e/login.e2e.ts");
  });

  it("detects .a11y.ts files", () => {
    expect(findNewTestFiles(["tests/home.a11y.ts"])).toContain("tests/home.a11y.ts");
  });

  it("detects .test.js and .spec.jsx variants", () => {
    const files = ["src/util.test.js", "src/comp.spec.jsx"];
    const result = findNewTestFiles(files);
    expect(result).toContain("src/util.test.js");
    expect(result).toContain("src/comp.spec.jsx");
  });

  it("passes: PR with a newly added test file satisfies the requirement", () => {
    const changedFiles = ["src/fix.ts", "src/fix.test.ts"];
    expect(findNewTestFiles(changedFiles).length).toBeGreaterThan(0);
  });
});

describe("hasExceptionBypass", () => {
  it("returns false when PR has no exception marker or label", () => {
    const pr = makePr({ body: "Normal PR body", labels: ["bug"] });
    expect(hasExceptionBypass(pr)).toBe(false);
  });

  it("returns true when PR body contains the exception HTML comment", () => {
    const pr = makePr({ body: `Some text ${EXCEPTION_MARKER} more text` });
    expect(hasExceptionBypass(pr)).toBe(true);
  });

  it("returns true when PR has the regression-test-exception label (exact case)", () => {
    const pr = makePr({ labels: [EXCEPTION_LABEL] });
    expect(hasExceptionBypass(pr)).toBe(true);
  });

  it("returns true when exception label is mixed-case", () => {
    const pr = makePr({ labels: ["Regression-Test-Exception"] });
    expect(hasExceptionBypass(pr)).toBe(true);
  });
});

describe("gate logic integration", () => {
  it("gate passes (no UAT refs detected) — no action needed", () => {
    const pr = makePr({ title: "Refactor auth", body: "No bugs here" });
    const uatIds = extractUatIds(pr);
    expect(uatIds).toHaveLength(0);
  });

  it("gate fails when UAT ID is in title but no test file is added", () => {
    const pr = makePr({ title: "Fix UAT-2024-001", changedFiles: ["src/fix.ts"] });
    const uatIds = extractUatIds(pr);
    const testFiles = findNewTestFiles(pr.changedFiles);
    const exception = hasExceptionBypass(pr);
    expect(uatIds.length).toBeGreaterThan(0);
    expect(testFiles).toHaveLength(0);
    expect(exception).toBe(false);
  });

  it("gate passes when UAT ID is present but a new test file is included", () => {
    const pr = makePr({
      title: "Fix UAT-2024-001",
      changedFiles: ["src/fix.ts", "src/fix.test.ts"],
    });
    const uatIds = extractUatIds(pr);
    const testFiles = findNewTestFiles(pr.changedFiles);
    expect(uatIds.length).toBeGreaterThan(0);
    expect(testFiles.length).toBeGreaterThan(0);
  });

  it("gate passes via exception when UAT ID is present, no test file, but exception marker set", () => {
    const pr = makePr({
      title: "Fix UAT-2024-001",
      body: `Explanation ${EXCEPTION_MARKER}`,
      changedFiles: ["src/fix.ts"],
    });
    const uatIds = extractUatIds(pr);
    const testFiles = findNewTestFiles(pr.changedFiles);
    const exception = hasExceptionBypass(pr);
    expect(uatIds.length).toBeGreaterThan(0);
    expect(testFiles).toHaveLength(0);
    expect(exception).toBe(true);
  });
});
