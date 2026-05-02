/**
 * Defensive payload scrubber for the failed-jobs notification surface.
 *
 * The job-detail UI shows the original `payload` to admins so they can
 * understand WHY a job failed (which CSV row, which ERP query, etc.).
 * Some payloads carry caller-supplied configuration that we do not want
 * to render verbatim in the browser — webhook secrets, OAuth tokens,
 * connection passwords, signing keys, etc. None of our current job
 * kinds intentionally accept these fields at the top level, but a
 * future kind (or a misuse from the wild) shouldn't be one keystroke
 * away from leaking a credential on a banner.
 *
 * The strategy is intentionally conservative:
 *   - Walk the JSON tree (objects + arrays).
 *   - Replace any string/number value whose KEY name (case-insensitive)
 *     matches a denylist of credential-shaped names with `[REDACTED]`.
 *   - Truncate any remaining string longer than `STRING_CAP_CHARS`
 *     so a runaway base64 blob doesn't wedge the UI.
 *   - Cap recursion depth and total node count so a maliciously deep
 *     payload can't pin a CPU on the response path.
 *
 * This is a structural redactor, not a regex DLP scanner — we don't
 * try to find unkeyed credentials hidden inside ordinary string
 * fields. The companion `replit.md` follow-up names a longer-term
 * "payload allowlist per job kind" project for that.
 */

const REDACTED = "[REDACTED]";

/**
 * Match credential-shaped key names. Case-insensitive substring match
 * on the key name keeps the rule simple and predictable: a key
 * containing any of these tokens is redacted.
 */
const SENSITIVE_KEY_TOKENS: readonly string[] = [
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "api_key",
  "authorization",
  "auth",
  "cookie",
  "session",
  "private_key",
  "privatekey",
  "client_secret",
  "clientsecret",
  "credential",
  "signature",
  "bearer",
];

const STRING_CAP_CHARS = 1_000;
const MAX_DEPTH = 8;
const MAX_NODES = 500;

function keyIsSensitive(key: string): boolean {
  const lower = key.toLowerCase();
  for (const token of SENSITIVE_KEY_TOKENS) {
    if (lower.includes(token)) return true;
  }
  return false;
}

function truncateString(s: string): string {
  if (s.length <= STRING_CAP_CHARS) return s;
  return `${s.slice(0, STRING_CAP_CHARS)}…[truncated, ${s.length} chars total]`;
}

function walk(
  value: unknown,
  depth: number,
  budget: { nodes: number },
): unknown {
  if (budget.nodes <= 0 || depth > MAX_DEPTH) {
    return "[truncated]";
  }
  budget.nodes -= 1;

  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === "string") return truncateString(value as string);
  if (t === "number" || t === "boolean") return value;

  if (Array.isArray(value)) {
    return value.map((v) => walk(v, depth + 1, budget));
  }

  if (t === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (keyIsSensitive(k)) {
        out[k] = REDACTED;
        continue;
      }
      out[k] = walk(v, depth + 1, budget);
    }
    return out;
  }

  // Fallback for things we can't safely render (functions, symbols,
  // bigints, etc.). These shouldn't reach here since `payload` is a
  // JSON column, but stay defensive.
  return `[unrenderable:${t}]`;
}

/**
 * Returns a defensively-scrubbed copy of the job payload safe to ship
 * to a browser. Always returns an object (even if the input was null
 * or non-object) so the client can render `Object.entries(...)`
 * without a guard.
 */
export function redactJobPayload(
  payload: unknown,
): Record<string, unknown> {
  const budget = { nodes: MAX_NODES };
  const walked = walk(payload ?? {}, 0, budget);
  if (walked && typeof walked === "object" && !Array.isArray(walked)) {
    return walked as Record<string, unknown>;
  }
  // Wrap non-object inputs so the wire shape stays uniform.
  return { value: walked };
}
