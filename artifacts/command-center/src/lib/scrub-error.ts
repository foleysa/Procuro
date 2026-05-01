/**
 * Render-time error scrubber (#209 step 1).
 *
 * Strips internal stack-trace artifacts from strings that flow into the
 * error/failure-state rendering boundary on the Today page (and any
 * other surface that wants the same contract). Scope per RT-91: this
 * helper runs *only* on strings that are about to be displayed inside
 * an "X is unavailable / failed" UI element. Legitimate card content
 * (an alert title, a job kind label, an opportunity name) bypasses it
 * and renders verbatim — see `today.tsx` for the call sites.
 *
 * The denylist is intentionally narrow for the known leak surface
 * (raw SQL, dollar param markers, `params:` blobs, file paths,
 * stack-frame markers). A broader template-allowlist (only render
 * error messages from a known-safe template registry) is the correct
 * long-term contract; it is named in `replit.md` as a follow-up and is
 * not in scope for #209.
 *
 * If the scrubber strips everything, we substitute a neutral phrase so
 * the UI never falls back to the empty string (which would render an
 * empty error ribbon).
 */
const SQL_KEYWORD_RE =
  /\b(?:select|from|where|group\s+by|order\s+by|join|insert|update|delete|values|returning)\b/gi;
const DOLLAR_PARAM_RE = /\$\d+/g;
const PARAMS_BLOB_RE = /\bparams\s*:\s*[^]*$/i;
const FILE_PATH_RE = /(?:[A-Za-z]:)?(?:\/|\\)[^\s)]+\.(?:ts|tsx|js|mjs|cjs)/g;
const STACK_FRAME_RE = /\bat\s+[A-Za-z_$][\w$.]*\s*\([^)]*\)/g;
const FAILED_QUERY_RE = /\bFailed\s+query:\s*[^\n]*/gi;

export function scrubError(raw: string | undefined | null): string {
  if (!raw) return "Source unavailable.";
  let s = String(raw);

  // Order matters: kill the "Failed query: ..." preface and `params:`
  // blob first because they're the highest-signal leak markers, then
  // chip away at residual SQL fragments and stack frames.
  s = s.replace(FAILED_QUERY_RE, "");
  s = s.replace(PARAMS_BLOB_RE, "");
  s = s.replace(STACK_FRAME_RE, "");
  s = s.replace(FILE_PATH_RE, "");
  s = s.replace(SQL_KEYWORD_RE, "");
  s = s.replace(DOLLAR_PARAM_RE, "");

  // Collapse whitespace, trim residual punctuation that the deletions
  // left dangling.
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/^[\s,;:.\-]+|[\s,;:.\-]+$/g, "");

  if (s.length === 0) {
    return "Source unavailable.";
  }
  return s;
}
