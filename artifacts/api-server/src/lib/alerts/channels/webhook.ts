/**
 * Webhook channel adapter.
 *
 * Posts a JSON body to `config.url`. Body is signed with HMAC-SHA256
 * over the raw bytes using `config.secret`. Receivers verify by
 * computing the same HMAC and comparing in constant time.
 *
 * Headers:
 *   - `Content-Type: application/json`
 *   - `X-Procuro-Signature: sha256=<hex>`
 *   - `X-Procuro-Timestamp: <unix-seconds>` — included in the signed
 *     payload via the `signaturePayload` envelope so receivers can
 *     reject replays.
 *   - `X-Procuro-Alert-Id: <alert id>`
 *
 * Configuration shape:
 *   { url: string, secret: string }
 *
 * The HMAC is intentionally computed over the JSON-stringified
 * envelope (not the raw alert) so the signature commits to the
 * timestamp as well as the body, defeating naive replay.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { AlertRow, AlertChannelRow } from "@workspace/db";
import { assertSafeUrl, assertSafeUrlResolved, SsrfBlockedError } from "../../ssrf-guard";
import {
  ChannelConfigError,
  type ChannelAdapter,
  type ChannelDeliveryResult,
} from "./types";

interface WebhookConfig {
  url: string;
  secret: string;
}

/**
 * Test-only escape hatch. When set to "1" we accept HTTP + loopback URLs
 * so the in-process webhook delivery test can spin up a real receiver on
 * 127.0.0.1 and exercise the full sign/POST/parse path. Never set in
 * production — guarded by an explicit non-default value.
 */
function ssrfBypassedForTesting(): boolean {
  return process.env["ALERTS_WEBHOOK_TEST_BYPASS_SSRF"] === "1";
}

function readConfig(config: Record<string, unknown>): WebhookConfig {
  const url = config["url"];
  const secret = config["secret"];
  const bypass = ssrfBypassedForTesting();
  const urlPattern = bypass ? /^https?:\/\//i : /^https:\/\//i;
  if (typeof url !== "string" || !urlPattern.test(url)) {
    throw new ChannelConfigError(
      "webhook channel requires `url` (HTTPS URL)",
    );
  }
  if (!bypass) {
    try {
      assertSafeUrl(url, { requireHttps: true });
    } catch (err) {
      throw new ChannelConfigError(
        err instanceof SsrfBlockedError
          ? `webhook url rejected: ${err.message}`
          : "webhook url is not allowed",
      );
    }
  }
  if (typeof secret !== "string" || secret.length < 16) {
    throw new ChannelConfigError(
      "webhook channel requires `secret` (>= 16 chars)",
    );
  }
  return { url, secret };
}

/**
 * Build the JSON body sent to the webhook receiver and the
 * accompanying HMAC signature. Exported so tests (and any future
 * receiver libraries we ship) can verify the signature scheme without
 * having to actually mount a webhook server.
 */
export function buildWebhookEnvelope(
  alert: AlertRow,
  secret: string,
  timestampSec: number,
): { body: string; signatureHex: string; timestampSec: number } {
  const envelope = {
    timestamp: timestampSec,
    alert: {
      id: alert.id,
      orgId: alert.orgId,
      severity: alert.severity,
      source: alert.source,
      kind: alert.kind,
      title: alert.title,
      summary: alert.summary,
      state: alert.state,
      occurrences: alert.occurrences,
      firstSeenAt: alert.firstSeenAt.toISOString(),
      lastSeenAt: alert.lastSeenAt.toISOString(),
      payload: alert.payload,
      entityUid: alert.entityUid,
      supplierId: alert.supplierId,
      contractId: alert.contractId,
      opportunityId: alert.opportunityId,
    },
  };
  const body = JSON.stringify(envelope);
  const signatureHex = createHmac("sha256", secret).update(body).digest("hex");
  return { body, signatureHex, timestampSec };
}

/**
 * Verify a webhook signature in constant time. Returns true iff the
 * provided signature matches HMAC-SHA256(secret, body). Exposed for
 * downstream test fixtures and the docs-page receiver example.
 */
export function verifyWebhookSignature(
  body: string,
  secret: string,
  signatureHex: string,
): boolean {
  const expected = createHmac("sha256", secret).update(body).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signatureHex, "hex");
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export const webhookChannelAdapter: ChannelAdapter = {
  kind: "webhook",
  validateConfig(config) {
    readConfig(config);
  },
  async send({
    alert,
    channel,
  }: {
    alert: AlertRow;
    channel: AlertChannelRow;
  }): Promise<ChannelDeliveryResult> {
    const { url, secret } = readConfig(
      channel.config as Record<string, unknown>,
    );
    const timestampSec = Math.floor(Date.now() / 1000);
    const { body, signatureHex } = buildWebhookEnvelope(
      alert,
      secret,
      timestampSec,
    );

    // DNS-resolution SSRF check: verify the destination hostname resolves
    // only to public IP ranges. This catches DNS-indirection bypasses
    // (e.g. attacker-controlled hostnames pointing to 10.x / 169.254.x)
    // that the synchronous schema-validation check cannot detect.
    if (!ssrfBypassedForTesting()) {
      try {
        await assertSafeUrlResolved(url, { requireHttps: true });
      } catch (err) {
        return {
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
          // Deliberately omit `url` from payload — destination URLs are
          // sensitive credentials and must not be disclosed to callers.
          payload: {},
        };
      }
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-procuro-signature": `sha256=${signatureHex}`,
          "x-procuro-timestamp": String(timestampSec),
          "x-procuro-alert-id": alert.id,
          "user-agent": "procuro-alerts/1.0",
        },
        body,
        // Disable redirect-following so a public URL cannot redirect the
        // backend to an internal address (redirect-based SSRF bypass).
        redirect: "error",
        // Belt-and-braces: a misbehaving receiver shouldn't be able to
        // pin the worker thread waiting for a response forever.
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      return {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        // Deliberately omit `url` — destination URLs are sensitive credentials.
        payload: {
          signature: `sha256=${signatureHex}`,
          timestamp: timestampSec,
        },
      };
    }

    const ok = res.status >= 200 && res.status < 300;
    return {
      status: ok ? "delivered" : "failed",
      httpStatus: res.status,
      error: ok ? undefined : `webhook returned HTTP ${res.status}`,
      // Deliberately omit `url` — destination URLs are sensitive credentials.
      payload: {
        signature: `sha256=${signatureHex}`,
        timestamp: timestampSec,
        bodySize: body.length,
      },
    };
  },
};
