# Regression Test Discipline

## The Rule

Every UAT bug, once fixed, becomes a permanent automated regression test. No exceptions.

A bug fix PR is not complete — and will not be merged — until a regression test exists that:
1. Reproduces the bug as written in the UAT report
2. Fails on the pre-fix codebase
3. Passes on the post-fix codebase
4. Lives in the correct layer of the test pyramid (see below)
5. Will run in CI on every future PR, forever

## Why this rule exists

UAT bugs are not bugs that "slipped through." They are bugs that the automated test pyramid did not cover. A UAT bug without a regression test is a guarantee that the same class of bug will recur — because nothing in CI is watching for it.

The cost of writing the regression test is paid once. The cost of not writing it is paid every time the bug recurs, plus the trust cost with whoever found it the first time.

## Workflow

When a UAT bug is reported:

1. **Triage:** Reproduce locally. Confirm the bug.
2. **Classify the layer:** Decide whether the regression test belongs as a unit test, an integration test, or an E2E test. Default to the lowest layer that can reproduce the bug. (See "Layer selection" below.)
3. **Write the failing test first:** Before fixing the bug, write the test that reproduces it. The test should fail on `main`.
4. **Fix the bug:** Make the test pass.
5. **PR:** The PR contains both the fix and the regression test. Reviewer verifies the test fails on `main` (by checking out `main` and running it) before approving.
6. **Tag the test:** Comment on the test with `// Regression: <UAT bug ID> — <one-line summary>` so future engineers know why it exists.

## Layer selection

| Bug type | Test layer |
|---|---|
| Wrong calculation, wrong data transformation, wrong validation logic | Unit test |
| Wrong query result, wrong DB constraint behavior, wrong API contract | Integration test (Vitest + Testcontainers Postgres per #311) |
| Wrong UI behavior, wrong navigation, wrong end-to-end workflow | E2E test (Playwright per #315) |
| Wrong data integrity at rest | Data integrity SQL assertion (per #313) |
| Wrong accessibility behavior | Accessibility test (axe-core per #314) |
| Wrong rendering or visual regression | Visual regression test (per #316) |
| Wrong performance under load | Performance test (k6 per #317) |

When in doubt, default to the lowest layer that can reproduce the bug. Lower-layer tests are faster, cheaper, and more durable.

## What this rule is not

This is not "write more tests." This is "write the test that would have caught this specific bug."

The regression test is not designed to cover the entire feature. It is designed to fail if this specific bug recurs. Future broader test coverage is a separate concern.

## Enforcement

This is a standing rule enforced by both CI and code review.

A GitHub Actions workflow (`.github/workflows/regression-test-check.yml`) automatically detects PRs that reference UAT-tagged issues (via the PR title, body, or branch name) and fails if no newly added test file is included. Only files with status `A` (added) count — modifying an existing test is not sufficient. The check script lives at `scripts/src/check-regression-tests.ts`.

A bug fix PR without a corresponding regression test is rejected by CI and by human review.

## Test naming convention

Regression tests should be named to make their origin obvious:

```
describe('Regression: UAT-2026-042 — duplicate opportunity stage history rows', () => {
  it('does not insert duplicate rows when stage transitions occur within the same OODA cycle', () => {
    // ...
  })
})
```

The format `Regression: <UAT-ID> — <human summary>` is required at the top-level `describe` (or equivalent in the test framework).

## Exceptions

There are no exceptions.

If a bug is impossible to reproduce in an automated test (e.g., a one-time data corruption from a manual operation), the PR description must explain why and propose a different defense — typically a runtime assertion, a data integrity check, or a monitoring alert. The reviewer must accept the alternative defense in writing on the PR.

"It's hard to write a test for this" is not an exception. Hard tests are the most valuable ones.
