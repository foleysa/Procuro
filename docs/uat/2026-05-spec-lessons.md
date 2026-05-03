# UAT 2026-05 — spec-author lessons learned (input to v3)

Author: Replit Agent (task #268, post-execution).
Audience: whoever writes `docs/uat/uat-2026-XX-spec-v3.md`.

## What the v2 spec got right

1. **Computed go/no-go.** The rule fired exactly as written and removed every degree of freedom around the result. The tester narrative does not have to be defensive; the metric does the work.
2. **Severity rubric embedded verbatim.** The promotion of D-04 from Major (v1) to Blocker (v2) was mechanical — `(c) security/tenant-isolation/audit defect` triggered, no debate.
3. **Risk-Accepted cap.** The five-question cap forced honesty. We hit the cap (Q1, Q2, Q3, Q14, browser substitution); a sixth Risk-Accepted answer would have escalated. Without the cap, the tester would have buried the missing-tester problem.
4. **Refusal protocol.** Made it possible to record "no exec sponsor available" as a refusal rather than a quiet skip; the result still defaults to No-Go, which is the safe default.
5. **One Given/When/Then per item in 4f.** Splitting the negative-test sweep into 4f.1–4f.8 caught D-15, D-16, D-17, D-19, D-23, D-24 individually. The v1 prose-bundled "do a negative sweep" would have surfaced as a single Pass/Fail with no actionable handles.

## What the v2 spec got wrong

1. **Step 4d (cross-tenant) assumed Tenant B existed.** It did not, and the spec did not have a fallback assertion. v3 should specify the seed contract for Tenant B and Tenant C as a *prerequisite* in Step 1.0 (env capture) — a missing seed is then a Step 1.0 Blocker, not a Step 4 Blocked-Upstream that drags the pass-rate denominator down twice (once for 4d, once for 4i).
2. **Step 4e LLM assertions were unrunnable when the signal store is empty.** v3 should make "≥3 T1/T2 signals seeded per lever" a Step 1.0 prerequisite as well, with an explicit assertion against `GET /api/signals` count.
3. **Step 4h (first-5-minutes) requires a fresh tenant + browser session.** The spec did not provide a mechanism for either. v3 should require the seed script to expose a `--ephemeral-tenant` flag that returns a tenant id usable for the test; and should mandate a Playwright harness that the tester can invoke.
4. **Step 12b (axe-core) was unrunnable because there is no harness wired into the workspace.** v3 should treat "axe-core harness present" as a Step 1.0 prerequisite, not a Step 12 deliverable.
5. **Step 13 "independent re-check" is hard when only one tester is named.** v3 should either:
   - drop the "ideally a different tester" wording and require a different correlation id only, or
   - require two named testers as a Step 0 prerequisite.
6. **Pilot feature-flag diff (Step 1.0) had no fallback when the pilot list is undocumented.** v3 should require the pilot flag YAML to exist as a Step 0 prerequisite; otherwise the gate cannot be run.
7. **Audit-log immutability assertion (§3) tests for `403 + new audit row` but our implementation returns `404`.** The 404 satisfies "cannot mutate" but not "every attempt is logged". v3 should keep the assertion as written (the application-layer fix is small) but add a temporary test that just verifies "PATCH/DELETE return some non-2xx and emit an audit row" — so the immutability test can pass before the 403 niceness is implemented.
8. **Performance thresholds P1–P3 require a browser; P4 requires a representative dataset; P5 requires a working pack pipeline.** v3 should accept `lighthouse-cli` headless against the proxy as a substitute for browser p95 and require a 1M-row CSV in the repo (or a generator script) so P4 is not env-blocked.
9. **Risk-Accepted #5 (browser substitution) was discovered at execution time, not at spec-write time.** v3 should pre-enumerate every "tester is in shell, not browser" substitution and either (a) gate them out of the Risk-Accepted budget by adding a "Tester surface" section that lists each surface explicitly, or (b) require a browser-equipped tester from the start.

## Three structural anti-patterns the v2 spec mostly avoided

1. **Reference-instead-of-content.** v2 transcribed every embedded artefact verbatim. (`§1` rubric, `§2` rule, `§3` audit-log assertion, `§4` perf thresholds.) v3 must keep doing this.
2. **Unbounded Risk-Accepted loophole.** Capped at 5; the cap was respected. v3 should keep the cap and add a *named-question allow-list* — only Q1, Q2, Q3, Q14, Q16, Q17 may be Risk-Accepted; any other question must have a substantive answer. (v2 currently allows Risk-Accepted on any question except the seven explicit "never" questions; v3 should invert that to a positive allow-list.)
3. **Collapse-to-prose.** v2 split 4f into 4f.1–4f.8 successfully. The remaining hot spot is Step 12 (12a/12b/12c/12d) — already split, but each sub-step has only one assertion. v3 should keep the split discipline at the page-level too: every cross-cutting check should be one G/W/T per concern.

## Process suggestion

v3 spec should be written by someone who is *not* the tester and *not* the implementer. The honesty disclosure at the top of the v2 report is a safety valve, not a substitute for that separation.
