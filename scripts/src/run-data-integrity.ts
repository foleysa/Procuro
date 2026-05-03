/**
 * `pnpm --filter @workspace/scripts run data-integrity`
 *
 * One-shot data integrity runner. Executes every assertion in
 * `@workspace/data-integrity` against the live database and persists
 * each result to `data_integrity_audit_log`. Exits non-zero on any
 * failure so it can be wired into CI / post-migration hooks.
 *
 * DB selection: if `DATA_INTEGRITY_DATABASE_URL` is set, it is
 * promoted to `DATABASE_URL` BEFORE the @workspace/db module is
 * imported (the module reads `DATABASE_URL` at import-time).
 *
 * The runner does NOT raise Slack alerts — only the in-process
 * scheduler does that. Re-enabling alerts here would double-fire.
 */
import { randomUUID } from "node:crypto";

const overrideUrl = process.env.DATA_INTEGRITY_DATABASE_URL;
if (overrideUrl && overrideUrl !== "") {
  process.env.DATABASE_URL = overrideUrl;
}
if (!process.env.DATABASE_URL) {
  console.error(
    "[data-integrity] No DATABASE_URL or DATA_INTEGRITY_DATABASE_URL set",
  );
  process.exit(1);
}

const triggeredBy: "post_migration" | "manual" = process.argv.includes(
  "--post-migration",
)
  ? "post_migration"
  : "manual";

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

async function main(): Promise<void> {
  const { db, pool, dataIntegrityAuditLogTable } = await import(
    "@workspace/db"
  );
  const { ALL_ASSERTIONS, runAssertions } = await import(
    "@workspace/data-integrity"
  );

  try {
    const results = await runAssertions(db, ALL_ASSERTIONS);
    const failed = results.filter((r) => !r.passed);

    if (results.length > 0) {
      await db.insert(dataIntegrityAuditLogTable).values(
        results.map((r) => ({
          id: newId("dia"),
          assertionName: r.name,
          family: r.family,
          passed: r.passed,
          actual: r.actual,
          expected: r.expected,
          message: r.message,
          triggeredBy,
        })),
      );
    }

    console.log(
      JSON.stringify(
        { total: results.length, failed: failed.length, results },
        null,
        2,
      ),
    );

    if (failed.length > 0) {
      console.error(
        `[data-integrity] ${failed.length} of ${results.length} assertions FAILED`,
      );
      process.exitCode = 1;
    } else {
      console.log(`[data-integrity] All ${results.length} assertions passed`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[data-integrity] fatal:", err);
  process.exit(1);
});
