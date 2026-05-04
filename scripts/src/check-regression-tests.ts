#!/usr/bin/env tsx

const UAT_PATTERN = /UAT-\d{4}-\d{2,4}/gi;

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

function isTestFile(filePath: string): boolean {
  return TEST_FILE_PATTERNS.some((p) => p.test(filePath));
}

function findNewTestFiles(changedFiles: string[]): string[] {
  return changedFiles.filter(isTestFile);
}

function run(): void {
  const title = process.env.PR_TITLE ?? "";
  const body = process.env.PR_BODY ?? "";
  const branchName = process.env.PR_BRANCH ?? "";
  const changedFilesRaw = process.env.CHANGED_FILES ?? "";

  const changedFiles = changedFilesRaw
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);

  const pr: PrInfo = { title, body, branchName, changedFiles };

  const uatIds = extractUatIds(pr);

  if (uatIds.length === 0) {
    console.log("✓ No UAT bug references detected — regression test check does not apply.");
    process.exit(0);
  }

  console.log(`UAT bug reference(s) detected: ${uatIds.join(", ")}`);
  console.log(`Checking for newly added test files in this PR...\n`);

  const testFiles = findNewTestFiles(changedFiles);

  if (testFiles.length > 0) {
    console.log(`✓ Found ${testFiles.length} newly added test file(s):`);
    for (const f of testFiles) console.log(`  • ${f}`);
    console.log("\nRegression test requirement satisfied.");
    process.exit(0);
  }

  console.error(`
╔══════════════════════════════════════════════════════════════════╗
║              REGRESSION TEST REQUIRED                          ║
╠══════════════════════════════════════════════════════════════════╣
║                                                                ║
║  This PR references UAT bug(s): ${uatIds.join(", ").padEnd(30)}║
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
║  alternative in writing.                                       ║
║                                                                ║
╚══════════════════════════════════════════════════════════════════╝
`);
  process.exit(1);
}

run();
