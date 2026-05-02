/**
 * Build a short, user-safe error message from an arbitrary thrown value
 * (typically a `pg` `DatabaseError`, a Drizzle wrapper around one, or any
 * other `Error`). The returned string is safe to send to a browser: it will
 * never include the SQL statement, bound parameter values, the
 * `detail`/`hint` text (which often quotes the offending value), or the
 * stack trace.
 *
 * The full original error should still be logged server-side via
 * `req.log.error({ err }, "...")` for debugging — `errorLogContext()`
 * extracts a structured snapshot suitable for Pino.
 *
 * Why this exists
 * ---------------
 * Failed CSV imports used to surface the raw Drizzle/Postgres error string
 * straight back to the browser. That string can include the full failing
 * SQL, the bound parameter values (which contain customer data such as
 * supplier names and invoice amounts), and internal schema details.
 */

const PG_ERROR_CODES: Record<string, string> = {
  // Class 23 — Integrity Constraint Violation
  "23000": "Integrity constraint violation",
  "23001": "Restrict violation",
  "23502": "Required value missing",
  "23503": "Foreign key violation",
  "23505": "Duplicate value violates unique constraint",
  "23514": "Check constraint violation",
  "23P01": "Exclusion constraint violation",
  // Class 22 — Data Exception
  "22001": "Value too long for column",
  "22003": "Numeric value out of range",
  "22007": "Invalid date/time format",
  "22008": "Date/time field overflow",
  "22012": "Division by zero",
  "22023": "Invalid parameter value",
  "22P02": "Invalid input value for column type",
  "22P05": "Untranslatable character in input",
  // Class 42 — Syntax Error or Access Rule Violation
  "42703": "Unknown column referenced",
  "42P01": "Unknown table referenced",
  "42P02": "Unknown parameter referenced",
  // Class 40 — Transaction Rollback
  "40001": "Serialization failure; please retry",
  "40P01": "Deadlock detected; please retry",
  // Class 53 — Insufficient Resources
  "53100": "Database is out of disk space",
  "53200": "Database is out of memory",
  "53300": "Too many database connections",
  // Class 57 — Operator Intervention
  "57014": "Query was cancelled",
  "57P01": "Database is shutting down",
  // Class 08 — Connection Exception
  "08000": "Database connection error",
  "08003": "Database connection closed",
  "08006": "Database connection failure",
};

interface PgLikeError {
  code?: unknown;
  table?: unknown;
  column?: unknown;
  constraint?: unknown;
  schema?: unknown;
  routine?: unknown;
}

function readString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asPgLike(err: unknown): PgLikeError | null {
  if (err === null || typeof err !== "object") return null;
  return err as PgLikeError;
}

/**
 * Treat a value as a `pg` `DatabaseError` if it looks like one. We avoid an
 * `instanceof` check because Drizzle / driver wrappers may rethrow a plain
 * `Error` whose own properties carry the SQLSTATE `code` field.
 */
function looksLikeDbError(err: unknown): err is PgLikeError {
  const pg = asPgLike(err);
  return !!pg && readString(pg.code) !== undefined;
}

/**
 * Find the nearest pg-like error in the cause chain. Drizzle's
 * `DrizzleQueryError` wraps the underlying `pg.DatabaseError` on `.cause`,
 * which means the SQLSTATE code, table, column, and constraint that drive
 * a useful summary live one level down — the outer wrapper itself only
 * carries a `Failed query: ... params: [...]` message. Without unwrapping,
 * a real Postgres conflict (e.g. SQLSTATE 23505 unique violation, 21000
 * cardinality violation) collapses to the static `"Internal server error
 * during import"` fallback and operators are left guessing.
 *
 * We walk a single `cause` level defensively. That is enough for the
 * `DrizzleQueryError` -> `pg.DatabaseError` shape we actually see in
 * production; deeper traversal risks chasing unrelated wrapped errors.
 */
function unwrapPgLikeError(err: unknown): PgLikeError | null {
  if (looksLikeDbError(err)) return err;
  const outer = asPgLike(err);
  if (!outer) return null;
  const cause = (outer as { cause?: unknown }).cause;
  if (cause === err) return null;
  if (looksLikeDbError(cause)) return cause;
  return null;
}

/**
 * Identifier-shaped strings (table names, column names, constraint names,
 * SQLSTATE codes) — these never contain caller-supplied data and are safe
 * to surface to the user. Reject anything else as a defense-in-depth guard
 * against a buggy driver populating these fields with row content.
 */
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SAFE_SQLSTATE = /^[A-Z0-9]{5}$/;

function safeIdent(v: unknown): string | undefined {
  const s = readString(v);
  if (!s) return undefined;
  if (s.length > 128) return undefined;
  return SAFE_IDENT.test(s) ? s : undefined;
}

function safeSqlState(v: unknown): string | undefined {
  const s = readString(v);
  if (!s) return undefined;
  return SAFE_SQLSTATE.test(s) ? s : undefined;
}

/**
 * Convert any error value into a short, human-friendly summary suitable for
 * returning to the browser. Never includes SQL, bound parameter values,
 * `detail`/`hint`/`where` text, or stack traces.
 *
 * For `pg`/Drizzle database errors the message is built from the SQLSTATE
 * code, table name, column name, and constraint name only.
 *
 * For non-DB errors a small whitelist of known, safe error subclasses
 * (e.g. multipart parse errors, the upload-too-large guard) is allowed
 * through verbatim; everything else collapses to a generic
 * `"Internal server error during import"` string.
 */
export function sanitizeDbErrorMessage(err: unknown): string {
  const pg = unwrapPgLikeError(err);
  if (pg) {
    const code = safeSqlState(pg.code);
    const kind = code ? PG_ERROR_CODES[code] : undefined;
    const table = safeIdent(pg.table);
    const column = safeIdent(pg.column);
    const constraint = safeIdent(pg.constraint);

    const headline = kind ?? (code ? `Database error ${code}` : "Database error");
    const parts: string[] = [];
    if (table) {
      parts.push(column ? `${table}.${column}` : `table "${table}"`);
    } else if (column) {
      parts.push(`column "${column}"`);
    }
    if (constraint) parts.push(`constraint "${constraint}"`);

    return parts.length > 0 ? `${headline} on ${parts.join(", ")}` : headline;
  }

  // Non-DB errors: only surface messages we know are safe (they were
  // constructed by our own code with no user data interpolated). Fall back
  // to a generic message otherwise.
  if (err instanceof Error) {
    const msg = err.message;
    if (isAllowlistedErrorMessage(msg)) return msg;
  }

  return "Internal server error during import";
}

/**
 * Allow our own static error strings through unchanged. These come from
 * code paths in the ingest route and CSV adapter and contain no
 * user-supplied data — only configuration limits and the like.
 */
function isAllowlistedErrorMessage(msg: string): boolean {
  if (msg.length > 300) return false;
  return (
    msg.startsWith("Upload exceeded ") ||
    msg.startsWith("Upload too large:") ||
    msg.startsWith("multipart/form-data request did not include") ||
    msg.startsWith("Invalid or missing 'entity'") ||
    msg.startsWith("Synchronous ingest is limited") ||
    msg.startsWith("streamCsvEntity: unknown entity") ||
    msg.startsWith("Body must include")
  );
}

/**
 * Pick out structured fields from a thrown value that are safe (and useful)
 * to write to the server log. Includes the full message and stack — those
 * stay server-side and are not echoed to the client.
 *
 * Callers can also pass the raw `err` value alongside the returned context
 * (e.g. `req.log.error({ err, ...errorLogContext(err) }, "...")`) to let
 * Pino's default `err` serializer attach the original error object's full
 * own-property surface for forensic debugging — the structured fields here
 * complement that with stable, queryable keys.
 */
export function errorLogContext(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const ctx: Record<string, unknown> = {
      errMessage: err.message,
      stack: err.stack,
    };
    // Mirror `sanitizeDbErrorMessage` and walk one `cause` level so a
    // Drizzle-wrapped `pg.DatabaseError` still contributes its SQLSTATE
    // / table / constraint to the structured log entry. Without this,
    // `req.log.error({ err, ...errorLogContext(err) }, ...)` would lose
    // the very fields on-call uses to grep production incidents.
    const pg = unwrapPgLikeError(err) ?? asPgLike(err);
    if (pg) {
      const code = readString(pg.code);
      const table = readString(pg.table);
      const column = readString(pg.column);
      const constraint = readString(pg.constraint);
      const schema = readString(pg.schema);
      const routine = readString(pg.routine);
      if (code) ctx["pgCode"] = code;
      if (table) ctx["pgTable"] = table;
      if (column) ctx["pgColumn"] = column;
      if (constraint) ctx["pgConstraint"] = constraint;
      if (schema) ctx["pgSchema"] = schema;
      if (routine) ctx["pgRoutine"] = routine;
    }
    return ctx;
  }
  return { errMessage: String(err) };
}
