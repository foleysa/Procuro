import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

/**
 * Symmetric AES-256-GCM helpers for ERP credential ciphertext.
 *
 * The encryption key is taken from `ERP_CREDENTIAL_ENCRYPTION_KEY`. The
 * env var should be a long random string (>=32 bytes after base64
 * decode); we sha256 it down to a 32-byte key so any sufficiently random
 * input works without forcing the operator to format it as base64.
 *
 * Layout of the stored ciphertext (base64):
 *
 *   iv (12 bytes) || ciphertext || authTag (16 bytes)
 *
 * Self-contained — every row carries its own IV+tag so a single-row
 * decrypt never needs to consult any other state. Auth tag verification
 * detects tampering: a wrong key, truncated payload, or modified bytes
 * all surface as a thrown error from `decryptCredentials`.
 *
 * In non-production environments we fall back to a deterministic dev
 * key when the env var is unset, so the local seed flow + tests can
 * round-trip without each developer having to set a secret. Production
 * boots refuse to encrypt with the dev key.
 */

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const ALGO = "aes-256-gcm";

const DEV_KEY_SOURCE =
  "procuro-dev-erp-credentials-key-do-not-use-in-production";

function isProduction(): boolean {
  return process.env["NODE_ENV"] === "production";
}

function resolveKey(): Buffer {
  const raw = process.env["ERP_CREDENTIAL_ENCRYPTION_KEY"];
  if (!raw || raw.trim() === "") {
    if (isProduction()) {
      throw new Error(
        "ERP_CREDENTIAL_ENCRYPTION_KEY is required in production to (en|de)crypt ERP credentials.",
      );
    }
    return createHash("sha256").update(DEV_KEY_SOURCE).digest();
  }
  // sha256 the raw input to a 32-byte key. This lets the operator
  // configure the secret as base64, hex, or any sufficiently-random
  // string without us imposing a specific encoding.
  return createHash("sha256").update(raw).digest();
}

/**
 * Encrypt an arbitrary JSON-serialisable object and return the
 * base64-encoded `iv || ciphertext || authTag` string suitable for
 * storage in `erp_connections.credentials_cipher`.
 */
export function encryptCredentials(plain: Record<string, unknown>): string {
  const key = resolveKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, key, iv);
  const json = Buffer.from(JSON.stringify(plain), "utf8");
  const enc = Buffer.concat([cipher.update(json), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, enc, tag]).toString("base64");
}

/**
 * Reverse of `encryptCredentials`. Throws on a mismatched key,
 * truncated payload, or tampered bytes (auth tag verification).
 */
export function decryptCredentials<T = Record<string, unknown>>(
  cipher: string,
): T {
  const key = resolveKey();
  const buf = Buffer.from(cipher, "base64");
  if (buf.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) {
    throw new Error("ERP credentials ciphertext is truncated or malformed.");
  }
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(buf.length - AUTH_TAG_LENGTH);
  const enc = buf.subarray(IV_LENGTH, buf.length - AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return JSON.parse(dec.toString("utf8")) as T;
}

/**
 * Surface a non-secret summary of which credential fields are present
 * for an existing row. Useful for the API/UI so we can show "client_id
 * configured ✓" without ever leaking the value.
 */
export function summarizeCredentialFields(
  cipher: string,
): { fields: string[] } {
  try {
    const obj = decryptCredentials<Record<string, unknown>>(cipher);
    return { fields: Object.keys(obj).sort() };
  } catch {
    return { fields: [] };
  }
}
