#!/usr/bin/env tsx

const UAT_PATTERN = /UAT-\d{4}-\d{2,4}/gi;
const EXCEPTION_MARKER = "<!-- REGRESSION-TEST-EXCEPTION -->";
const EXCEPTION_LABEL = "regression-test-exception";
const CLOSING_REF_PATTERN = /(?:closes?|fixes?|resolves?)\s+#(\d+)/gi;
const UAT_LABEL_PATTERN = /^uat/i;

const TEST_FILE_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /\.e2e\.[jt]sx?$/,
  /\.a11y\.[jt]sx?$/,
];

interface PrInfo {
  title: string;
  body: string;
  branchName: string;
  changedFiles: string[];
  labels: string[];
}

function extractUatIds(pr: PrInfo): string[] {
  const sources = [pr.title, pr.body, pr.branchName];
  const ids = new Set<string>();
  for (const source of sources) {
    if (!source) continue;
    const matches = source.match(UAT_PATTERN);
    if (matches) {
      for (const m of matches) ids.add(m.toUpperCase());
    }
  }
  return [...ids];
}

function extractClosingIssueNumbers(prBody: string): number[] {
  const numbers: number[] = [];
  const re = new RegExp(CLOSING_REF_PATTERN.source, "gi");
  let match: RegExpExecArray | null;
  while ((match = re.exec(prBody)) !== null) {
    numbers.push(parseInt(match[1], 10));
  }
  return numbers;
}

interface GitHubLabel {
  name: string;
}

interface GitHubIssue {
  title: string;
  labels: GitHubLabel[];
}

async function fetchLinkedIssueUatIds(
  prBody: string,
  token: string,
  repo: string
): Promise<string[]> {
  const issueNumbers = extractClosingIssueNumbers(prBody);
  if (issueNumbers.length === 0) return [];

  const ids = new Set<string>();

  for (const num of issueNumbers) {
    let issue: GitHubIssue;
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/issues/${num}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3+json",
        },
      });
      if (!res.ok) {
        console.warn(`  Warning: GitHub API returned ${res.status} for issue #${num} — skipping.`);
        continue;
      }
      issue = (await res.json()) as GitHubIssue;
    } catch (err) {
      console.warn(`  Warning: Failed to fetch issue #${num} from GitHub API — skipping. (${err})`);
      continue;
    }

    const titleMatches = issue.title.match(UAT_PATTERN);
    if (titleMatches) {
      for (const m of titleMatches) ids.add(m.toUpperCase());
    }

    const labels: GitHubLabel[] = issue.labels ?? [];
    const hasUatLabel = labels.some((l) => UAT_LABEL_PATTERN.test(l.name));
    if (hasUatLabel) {
      ids.add(`#${num}`);
    }
  }

  return [...ids];
}

function isTestFile(filePath: string): boolean {
  return TEST_FILE_PATTERNS.some((p) => p.test(filePath));
}

function findNewTestFiles(changedFiles: string[]): string[] {
  return changedFiles.filter(isTestFile);
}

function hasExceptionBypass(pr: PrInfo): boolean {
  if (pr.body && pr.body.includes(EXCEPTION_MARKER)) return true;
  if (pr.labels.map((l) => l.toLowerCase()).includes(EXCEPTION_LABEL)) return true;
  return false;
}

async function run(): Promise<void> {
  const title = process.env.PR_TITLE ?? "";
  const body = process.env.PR_BODY ?? "";
  const branchName = process.env.PR_BRANCH ?? "";
  const changedFilesRaw = process.env.CHANGED_FILES ?? "";
  const labelsRaw = process.env.PR_LABELS ?? "";
  const githubToken = process.env.GITHUB_TOKEN ?? "";
  const githubRepo = process.env.GITHUB_REPOSITORY ?? "";

  const changedFiles = changedFilesRaw
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);

  const labels = labelsRaw
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);

  const pr: PrInfo = { title, body, branchName, changedFiles, labels };

  const directUatIds = extractUatIds(pr);

  let linkedIssueUatIds: string[] = [];
  if (githubToken && githubRepo && body) {
    console.log("Checking linked GitHub issues for UAT references...");
    linkedIssueUatIds = await fetchLinkedIssueUatIds(body, githubToken, githubRepo);
    if (linkedIssueUatIds.length > 0) {
      console.log(`  UAT reference(s) found via linked issues: ${linkedIssueUatIds.join(", ")}`);
    }
  }

  const allUatIds = [...new Set([...directUatIds, ...linkedIssueUatIds])];

  if (allUatIds.length === 0) {
    console.log("✓ No UAT bug references detected — regression test check does not apply.");
    process.exit(0);
  }

  console.log(`UAT bug reference(s) detected: ${allUatIds.join(", ")}`);
  console.log(`Checking for newly added test files in this PR...\n`);

  const testFiles = findNewTestFiles(changedFiles);

  if (testFiles.length > 0) {
    console.log(`✓ Found ${testFiles.length} newly added test file(s):`);
    for (const f of testFiles) console.log(`  • ${f}`);
    console.log("\nRegression test requirement satisfied.");
    process.exit(0);
  }

  if (hasExceptionBypass(pr)) {
    console.warn(`
╔══════════════════════════════════════════════════════════════════╗
║          REGRESSION TEST EXCEPTION GRANTED — WARNING           ║
╠══════════════════════════════════════════════════════════════════╣
║                                                                ║
║  This PR references UAT bug(s): ${allUatIds.join(", ").padEnd(30)}║
║                                                                ║
║  A regression-test exception bypass has been detected (via     ║
║  the <!-- REGRESSION-TEST-EXCEPTION --> marker in the PR body  ║
║  or the "regression-test-exception" label on the PR).          ║
║                                                                ║
║  The CI gate is passing with a WARNING, not a failure.         ║
║                                                                ║
║  ⚠  REVIEWERS: You MUST verify before approving:              ║
║                                                                ║
║    1. The PR description explains clearly why a regression     ║
║       test is impossible for this specific bug.                ║
║    2. An alternative defense is proposed (runtime assertion,   ║
║       data integrity check, or monitoring alert).              ║
║    3. You have accepted the alternative defense IN WRITING     ║
║       in a review comment on this PR.                          ║
║                                                                ║
║  Approving without verifying these points violates the         ║
║  regression test discipline (docs/regression-test-            ║
║  discipline.md).                                               ║
║                                                                ║
╚══════════════════════════════════════════════════════════════════╝
`);
    process.exit(0);
  }

  console.error(`
╔══════════════════════════════════════════════════════════════════╗
║              REGRESSION TEST REQUIRED                          ║
╠══════════════════════════════════════════════════════════════════╣
║                                                                ║
║  This PR references UAT bug(s): ${allUatIds.join(", ").padEnd(30)}║
║                                                                ║
║  Per the regression test discipline (docs/regression-test-     ║
║  discipline.md), every bug fix PR that closes a UAT-tagged     ║
║  issue MUST include at least one new test file that:           ║
║                                                                ║
║    1. Reproduces the bug as written in the UAT report          ║
║    2. Fails on the pre-fix codebase                            ║
║    3. Passes on the post-fix codebase                          ║
║    4. Lives in the correct layer of the test pyramid           ║
║    5. Will run in CI on every future PR                        ║
║                                                                ║
║  Test files must match one of these patterns:                  ║
║    *.test.ts, *.test.tsx, *.spec.ts, *.spec.tsx,               ║
║    *.e2e.ts, *.e2e.tsx, *.a11y.ts, *.a11y.tsx                  ║
║    (also .js/.jsx variants)                                    ║
║                                                                ║
║  If this bug is truly impossible to reproduce in an automated  ║
║  test, explain why in the PR description and propose an        ║
║  alternative defense (runtime assertion, data integrity        ║
║  check, or monitoring alert). The reviewer must accept the     ║
║  alternative in writing. Then add the exception marker to      ║
║  the PR body: <!-- REGRESSION-TEST-EXCEPTION -->               ║
║                                                                ║
╚══════════════════════════════════════════════════════════════════╝
`);
  process.exit(1);
}

run();
