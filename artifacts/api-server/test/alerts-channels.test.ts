/**
 * Unit tests for the alert channel adapters.
 *
 * These pin the two contract surfaces that downstream integrators (and
 * receivers!) rely on:
 *
 *   1. The webhook adapter signs the raw JSON body with HMAC-SHA256
 *      over the *signed envelope* (timestamp + alert), and exposes a
 *      verifier that does the same comparison in constant time. A
 *      receiver implementation must use the same scheme; if either
 *      `buildWebhookEnvelope` or `verifyWebhookSignature` ever
 *      diverges, this test fails before the deploy.
 *
 *   2. The email adapter falls back to a `simulated` delivery when
 *      `SENDGRID_API_KEY` is unset, returning a structured payload
 *      with the rendered subject + recipient list. This is what the
 *      delivery worker records into `alert_deliveries.payload`, and
 *      what makes the rest of the notification pipeline (idempotency,
 *      escalation cancellation) exercise end-to-end on dev tenants
 *      without a SendGrid account.
 *
 * The webhook test does not hit the network; it exercises the pure
 * envelope/verification helpers directly so it can run anywhere
 * (no DB, no `DATABASE_URL` required).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

if (!process.env["DATABASE_URL"]) {
  // `@workspace/db` is transitively imported by some channel modules'
  // type-only sibling imports. A syntactic placeholder lets the import
  // succeed; the tests below never open a connection.
  process.env["DATABASE_URL"] = "postgres://test:test@127.0.0.1:5432/test";
}

const { buildWebhookEnvelope, verifyWebhookSignature } = await import(
  "../src/lib/alerts/channels/webhook"
);
const { emailChannelAdapter } = await import("../src/lib/alerts/channels/email");

interface AlertLike {
  id: string;
  orgId: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  source: string;
  kind: string;
  title: string;
  summary: string;
  state: string;
  occurrences: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  payload: Record<string, unknown>;
  entityUid: string | null;
  supplierId: string | null;
  contractId: string | null;
  opportunityId: string | null;
}

function fakeAlert(over: Partial<AlertLike> = {}): AlertLike {
  const now = new Date("2025-06-01T12:00:00.000Z");
  return {
    id: "alert_test_1",
    orgId: "org_test_1",
    severity: "high",
    source: "collector",
    kind: "ofac_sdn_match",
    title: "Test alert",
    summary: "A test alert for the channel adapter contract.",
    state: "open",
    occurrences: 1,
    firstSeenAt: now,
    lastSeenAt: now,
    payload: { sources: [] },
    entityUid: null,
    supplierId: null,
    contractId: null,
    opportunityId: null,
    ...over,
  };
}

test("webhook adapter signs the envelope with HMAC-SHA256 over (timestamp + alert)", () => {
  const alert = fakeAlert();
  const secret = "test-secret-at-least-16-chars";
  const ts = 1_725_000_000;

  const { body, signatureHex, timestampSec } = buildWebhookEnvelope(
    // The runtime adapter passes a real `AlertRow`; the envelope only
    // touches the wire-shaped fields, so a structurally-compatible
    // fixture is enough to pin the signing scheme.
    alert as unknown as Parameters<typeof buildWebhookEnvelope>[0],
    secret,
    ts,
  );

  assert.equal(timestampSec, ts, "timestamp must round-trip into the envelope");

  // The body must parse back into the same shape we emit.
  const parsed = JSON.parse(body) as {
    timestamp: number;
    alert: { id: string; severity: string };
  };
  assert.equal(parsed.timestamp, ts, "envelope must include the timestamp");
  assert.equal(parsed.alert.id, alert.id);
  assert.equal(parsed.alert.severity, alert.severity);

  // Signature must be HMAC-SHA256(secret, body), computed independently
  // here so a refactor that swaps algorithms is caught.
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  assert.equal(
    signatureHex,
    expected,
    "signature must be HMAC-SHA256 of the JSON body",
  );

  // The verifier must accept the matching signature.
  assert.equal(
    verifyWebhookSignature(body, secret, signatureHex),
    true,
    "verifier must accept its own signature",
  );
});

test("webhook verifier rejects tampered payload, swapped secret, and malformed hex", () => {
  const alert = fakeAlert();
  const secret = "test-secret-at-least-16-chars";
  const { body, signatureHex } = buildWebhookEnvelope(
    alert as unknown as Parameters<typeof buildWebhookEnvelope>[0],
    secret,
    1_725_000_000,
  );

  // Mutate the body by even one byte → signature must no longer verify.
  const tampered = body.replace('"severity":"high"', '"severity":"low"');
  assert.equal(
    verifyWebhookSignature(tampered, secret, signatureHex),
    false,
    "tampered body must fail verification",
  );

  // Different secret → must not verify.
  assert.equal(
    verifyWebhookSignature(body, "another-secret-of-equal-length__", signatureHex),
    false,
    "verification must depend on the secret",
  );

  // Truncated hex → must reject (length mismatch short-circuits to false).
  assert.equal(
    verifyWebhookSignature(body, secret, signatureHex.slice(0, 32)),
    false,
    "short signature must be rejected, not throw",
  );

  // Non-hex garbage → must reject without throwing.
  assert.equal(
    verifyWebhookSignature(body, secret, "not-hex-at-all-zzz"),
    false,
    "malformed hex must be rejected, not throw",
  );
});

test("email adapter records a simulated delivery when SENDGRID_API_KEY is unset", async () => {
  // Belt-and-braces: regardless of what's in the dev shell, force
  // SENDGRID_API_KEY off for the scope of this test so the simulated
  // branch is exercised deterministically.
  const previous = process.env["SENDGRID_API_KEY"];
  delete process.env["SENDGRID_API_KEY"];

  try {
    const alert = fakeAlert({
      severity: "critical",
      title: "Sanctions hit on Acme Trading Co",
    });
    const channel = {
      // Only the `config` field is read by the email adapter.
      config: { to: ["ops@example.test"], from: "alerts@example.test" },
      kind: "email" as const,
    };

    const result = await emailChannelAdapter.send({
      alert: alert as unknown as Parameters<
        typeof emailChannelAdapter.send
      >[0]["alert"],
      channel: channel as unknown as Parameters<
        typeof emailChannelAdapter.send
      >[0]["channel"],
    });

    assert.equal(
      result.status,
      "simulated",
      "no SENDGRID_API_KEY → status must be simulated, not delivered or failed",
    );
    const payload = result.payload as {
      to: string[];
      from: string;
      subject: string;
      reason: string;
    };
    assert.deepEqual(payload.to, ["ops@example.test"]);
    assert.equal(payload.from, "alerts@example.test");
    assert.ok(
      payload.subject.includes("CRITICAL"),
      `subject must include severity tag, got "${payload.subject}"`,
    );
    assert.ok(
      payload.subject.includes("Sanctions hit on Acme Trading Co"),
      `subject must include alert title, got "${payload.subject}"`,
    );
    assert.match(
      payload.reason,
      /SENDGRID_API_KEY/,
      "simulated payload must explain why delivery was simulated",
    );
  } finally {
    if (previous === undefined) {
      delete process.env["SENDGRID_API_KEY"];
    } else {
      process.env["SENDGRID_API_KEY"] = previous;
    }
  }
});

test("email adapter rejects an invalid recipient with a config error", async () => {
  // Validation is shared between `validateConfig` (used at channel
  // create time) and `send` (defence in depth). Pin that an obviously
  // bad address is rejected at send time too, so a misconfigured
  // channel doesn't silently no-op.
  const alert = fakeAlert();
  const channel = {
    config: { to: ["not-an-email"], from: "alerts@example.test" },
    kind: "email" as const,
  };
  await assert.rejects(
    () =>
      emailChannelAdapter.send({
        alert: alert as unknown as Parameters<
          typeof emailChannelAdapter.send
        >[0]["alert"],
        channel: channel as unknown as Parameters<
          typeof emailChannelAdapter.send
        >[0]["channel"],
      }),
    /invalid recipient/i,
  );
});
