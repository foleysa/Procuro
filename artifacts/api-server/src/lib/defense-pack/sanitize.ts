/**
 * Prompt-injection defence for Defense Pack inputs.
 *
 * The Defense Pack pipeline assembles a prompt from three sources:
 *  1. The buyer-typed `position` text (free-form).
 *  2. The `target` description (supplier name, contract line, category,
 *     material code).
 *  3. The frozen evidence pool (signal value, unit, observed-at,
 *     source URL, collector name) — pulled from our own DB, not the
 *     internet, so the trust surface is small but non-zero.
 *
 * The first two come from the user; the third is plumbed through the
 * `metadata.note` and `sourceUrl` columns, which are populated from
 * upstream collectors. We treat all three as untrusted text and
 * sanitise them before composing the system prompt.
 *
 * The sanitiser is deliberately conservative — its job is to defang
 * obvious instruction-injection vectors (role-switching tokens,
 * "ignore previous", embedded URLs as instructions, base64-encoded
 * blobs). It does NOT try to interpret the text semantically. The
 * downstream verifier is the primary defence: the LLM must cite
 * `signalId`s from the evidence snapshot, and the verifier drops any
 * claim whose cited value disagrees with the snapshot. So even if a
 * malicious `metadata.note` somehow slips a fabricated number past the
 * sanitiser, the verifier prevents it from reaching the rendered memo.
 */

const ROLE_SWITCH_TOKENS = [
  /\bsystem\s*:/gi,
  /\bassistant\s*:/gi,
  /\buser\s*:/gi,
  /<\s*\/?\s*system\s*>/gi,
  /<\s*\/?\s*assistant\s*>/gi,
  /<\s*\/?\s*user\s*>/gi,
  /\|im_(start|end|sep)\|/gi,
  /<\|.*?\|>/g,
];

const INSTRUCTION_OVERRIDE_PHRASES = [
  /\bignore\s+(all\s+)?previous\s+(instructions?|prompts?|rules?)/gi,
  /\bdisregard\s+(all\s+)?previous\s+(instructions?|prompts?|rules?)/gi,
  /\b(now|instead)\s+do\s+the\s+following/gi,
  /\byou\s+are\s+now\s+(a|an)\s+/gi,
  /\bact\s+as\s+(a|an)\s+/gi,
  /\bnew\s+instructions?\b/gi,
  /\boverride\s+(your\s+)?(system\s+)?(prompt|instructions?)/gi,
];

const BASE64_BLOB = /\b[A-Za-z0-9+/]{120,}={0,2}\b/g;

const URL_AS_INSTRUCTION = /(?:fetch|visit|go to|browse|open|load|download)\s+(?:this\s+)?(?:url|link)?\s*(?:at\s+)?https?:\/\/\S+/gi;

const REDACTED = "[redacted]";

/**
 * Sanitise an untrusted free-text snippet that will be injected into a
 * Gemini prompt. Returns the cleaned string. Applies, in order:
 *  - Role/turn-marker stripping (system:/assistant:/<|im_start|>/...).
 *  - Instruction-override phrase removal ("ignore previous", "act as
 *    a", "new instructions"...).
 *  - URL-as-command removal ("fetch https://...", "visit https://...").
 *  - Long base64 blob redaction (>=120 chars of base64 alphabet).
 *  - Length cap.
 *
 * The function is idempotent and side-effect free.
 */
export function sanitizeUntrustedText(
  input: string | null | undefined,
  opts: { maxLength?: number } = {},
): string {
  if (input == null) return "";
  let text = String(input);
  for (const re of ROLE_SWITCH_TOKENS) text = text.replace(re, REDACTED);
  for (const re of INSTRUCTION_OVERRIDE_PHRASES) text = text.replace(re, REDACTED);
  text = text.replace(URL_AS_INSTRUCTION, REDACTED);
  text = text.replace(BASE64_BLOB, REDACTED);
  // Strip ASCII control chars except whitespace.
  text = text.replace(/[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F]/g, " ");
  text = text.replace(/\s+/g, " ").trim();
  const maxLength = opts.maxLength ?? 4000;
  if (text.length > maxLength) text = text.slice(0, maxLength) + "…";
  return text;
}
