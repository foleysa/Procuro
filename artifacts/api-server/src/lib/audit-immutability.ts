import { pool } from "@workspace/db";
import { logger } from "./logger";

/**
 * Physical (DB-level) append-only protection for `admin_audit_log`.
 *
 * Application-layer enforcement (route handlers refusing PATCH/DELETE)
 * is not enough — anyone with the application's DB credentials could
 * still issue a raw UPDATE / DELETE and rewrite history. UAT v2 D-21
 * calls this out as a Major finding.
 *
 * Defense in depth:
 *  1. A `BEFORE UPDATE OR DELETE` row-level trigger raises an exception
 *     on every attempt, so even a direct `psql` mutation by the app role
 *     fails.
 *  2. Best-effort `REVOKE UPDATE, DELETE, TRUNCATE` on the table from
 *     the currently-connected role. If the app runs as a superuser /
 *     table owner the REVOKE is a no-op (owners always retain
 *     privileges) but the trigger still blocks them. When the app is
 *     later moved to a least-privilege role the REVOKE becomes the
 *     primary defense and the trigger is the belt-and-braces backup.
 *
 * Test-suite escape hatch
 * -----------------------
 * Tests need to delete their own seeded audit rows during cleanup.
 * The trigger looks at the session-local GUC `app.audit_bypass`; when
 * set to `'on'` it returns early without raising. Production code has
 * no caller that sets this — only the `withAuditBypass` helper below
 * does, and it scopes the setting to a single transaction.
 *
 * Idempotent: the function uses `CREATE OR REPLACE FUNCTION` and
 * `DROP TRIGGER IF EXISTS` so repeated boots are safe.
 */
const AUDIT_TABLE = "admin_audit_log";
const TRIGGER_NAME = "trg_admin_audit_log_append_only";
const TRIGGER_FN_NAME = "enforce_audit_log_append_only";

const TRIGGER_FN_DDL = `
CREATE OR REPLACE FUNCTION ${TRIGGER_FN_NAME}()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Test-suite escape hatch — see audit-immutability.ts header. The
  -- two-arg form of current_setting() returns NULL instead of raising
  -- when the GUC has never been set in this session.
  IF current_setting('app.audit_bypass', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    ELSE
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION
    'audit log is append-only: % on % is not permitted',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
`;

let bootstrapped = false;

export async function bootstrapAuditLogImmutability(): Promise<void> {
  if (bootstrapped) return;
  await pool.query(TRIGGER_FN_DDL);
  await pool.query(`DROP TRIGGER IF EXISTS ${TRIGGER_NAME} ON ${AUDIT_TABLE};`);
  await pool.query(
    `CREATE TRIGGER ${TRIGGER_NAME}
       BEFORE UPDATE OR DELETE ON ${AUDIT_TABLE}
       FOR EACH ROW
       EXECUTE FUNCTION ${TRIGGER_FN_NAME}();`,
  );
  // Best-effort: revoke mutation privileges from the connecting role.
  // If the role owns the table this silently succeeds but has no effect
  // (owners keep all privileges); the trigger above is still the
  // backstop. When the app is later moved to a least-privilege role
  // this becomes the primary defense.
  try {
    await pool.query(
      `REVOKE UPDATE, DELETE, TRUNCATE ON TABLE ${AUDIT_TABLE} FROM CURRENT_USER;`,
    );
  } catch (err) {
    logger.warn(
      { err, table: AUDIT_TABLE },
      "audit-log REVOKE failed; trigger remains the enforcement layer",
    );
  }
  bootstrapped = true;
  logger.info(
    { table: AUDIT_TABLE },
    "Audit log append-only trigger bootstrapped",
  );
}

/**
 * Run the given async callback inside a transaction with the audit-log
 * append-only trigger temporarily bypassed. Intended for test cleanup
 * ONLY — never call this from production code paths.
 *
 * The helper opens a dedicated client so the `SET LOCAL app.audit_bypass`
 * applies only to the queries inside the callback (and only inside the
 * transaction it owns). The callback receives the borrowed pg client
 * and is responsible for issuing its DELETEs on that client.
 */
export async function withAuditBypass<T>(
  fn: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL app.audit_bypass = 'on'");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Test-only: force re-bootstrap on next call. */
export function __resetAuditImmutabilityBootstrap(): void {
  bootstrapped = false;
}
