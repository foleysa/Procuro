/**
 * Integration test for the webhook channel adapter against a real, in-
 * process HTTP receiver, driven end-to-end through `deliverAlertsTick`.
 *
 * The unit tests in `alerts-channels.test.ts` already pin the pure
 * envelope/signature helpers (`buildWebhookEnvelope`,
 * `verifyWebhookSignature`). What they DON'T cover is the actual
 * `fetch` path inside `webhookChannelAdapter.send` — header casing,
 * `X-Procuro-Signature` placement, the `application/json` content-type,
 * the unix-second `X-Procuro-Timestamp`, and the `delivered` /
 * `failed` translation that `deliverAlertsTick` performs on the
 * receiver's HTTP status code.
 *
 * A regression that broke any of those (e.g. a refactor that swapped
 * the signature header name, or stopped writing `bodySize` into the
 * delivery payload, or that dropped the body's HMAC commitment to the
 * timestamp) would slip past the channel-helper tests but would silently
 * break every customer's webhook receiver. This test catches that by
 * standing up a tiny `node:http` server, registering a real webhook
 * channel pointing at it, creating an alert, and letting the regular
 * delivery worker do its thing.
 *
 * Two scenarios are pinned:
 *
 *   1. Happy path — receiver returns 200. We assert:
 *        - the receiver saw `POST` with `content-type: application/json`,
 *        - `x-procuro-signature: sha256=<hex>` is present and verifies
 *          against the JSON body using `verifyWebhookSignature` with
 *          the configured channel secret,
 *        - `x-procuro-timestamp` and `x-procuro-alert-id` are correct,
 *        - the parsed body envelope contains the alert id, severity,
 *          and the timestamp matches the header,
 *        - the `alert_deliveries` row transitioned to `state='sent'`,
 *          `attempts=1`, `sentAt` set, `lastError` cleared,
 *        - an `alert_events` row of type `delivered` was appended with
 *          `metadata.httpStatus = 200` and `metadata.channelKind =
 *          "webhook"`.
 *
 *   2. Failure path — a second receiver returns HTTP 500 on every
 *      request. We assert:
 *        - the `alert_deliveries` row transitioned to `state='failed'`,
 *          `attempts=1`, `lastError` contains the HTTP 500 reference
 *          (this is what surfaces in the operator inbox / job logs),
 *        - an `alert_events` row of type `delivery_failed` was appended
 *          with `metadata.httpStatus = 500`.
 *
 * Prereqs:
 *   - `DATABASE_URL` is set and the schema has been pushed
 *     (`pnpm --filter @workspace/db run push`).
 */
// Test escape hatch: the webhook adapter's SSRF guard rejects HTTP and
// loopback URLs in production. This integration test deliberately stands
// up a real `node:http` receiver on 127.0.0.1, so we opt the adapter into
// the test-only bypass at module-eval time. The adapter reads this env
// var dynamically (per call), so it just needs to be set before
// `deliverAlertsTick()` is invoked from `test.before`.
process.env["ALERTS_WEBHOOK_TEST_BYPASS_SSRF"] = "1";

import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { AddressInfo } from "node:net";

import {
  db,
  pool,
  alertChannelsTable,
  alertDeliveriesTable,
  alertEventsTable,
  alertSubscriptionsTable,
  orgsTable,
  usersTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { createAlert } from "@workspace/intelligence";
import { newId } from "../src/lib/ids";
import { deliverAlertsTick } from "../src/lib/alerts/delivery";
import { verifyWebhookSignature } from "../src/lib/alerts/channels/webhook";

// Channel secret is shared by both the channel config we insert and
// the verifier we run on the server side. Must be >=16 chars to pass
// the adapter's `readConfig` validation.
const WEBHOOK_SECRET = "test-secret-please-32-chars-long-xx";

const RUN = `webhook-delivery-${Date.now()}-${process.pid}`;
const orgId = newId("org");
const userId = newId("usr");
const okChannelId = newId("ch");
const failChannelId = newId("ch");
const okSubscriptionId = newId("sub");
const failSubscriptionId = newId("sub");

interface Capture {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/**
 * Spin up a tiny HTTP receiver. Each request is captured into the
 * provided array and the response is whatever `responder` returns.
 *
 * Bound to 127.0.0.1 on port 0 so the OS picks a free port and the
 * test never collides with anything else on the box (or with a
 * previous run that leaked a socket).
 */
async function startReceiver(
  captures: Capture[],
  responder: (req: IncomingMessage) => { status: number; body?: string },
): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      captures.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body,
      });
      const out = responder(req);
      res.statusCode = out.status;
      res.setHeader("content-type", "text/plain");
      res.end(out.body ?? "");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${addr.port}/hook`,
  };
}

async function stopReceiver(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

const okCaptures: Capture[] = [];
const failCaptures: Capture[] = [];
let okServer: Server;
let failServer: Server;
let okUrl: string;
let failUrl: string;

test.before(async () => {
  // Start both receivers BEFORE the channel rows reference them — the
  // delivery worker doesn't run yet, but inserting URLs we haven't bound
  // would invite flakiness if anything were to retry eagerly.
  ({ server: okServer, url: okUrl } = await startReceiver(
    okCaptures,
    () => ({ status: 200, body: "ok" }),
  ));
  ({ server: failServer, url: failUrl } = await startReceiver(
    failCaptures,
    () => ({ status: 500, body: "boom" }),
  ));

  await db.insert(orgsTable).values({
    id: orgId,
    name: `${RUN} Test Org`,
    slug: `${RUN}-org`,
  });
  await db.insert(usersTable).values({
    id: userId,
    orgId,
    email: `webhook-${RUN}@example.test`,
    name: "Webhook Receiver",
    role: "admin",
  });

  // Two webhook channels — one happy-path receiver and one that always
  // 500s. Each gets its own subscription so the fan-out math stays
  // independent: one alert → one delivery per (subscription, channel).
  await db.insert(alertChannelsTable).values([
    {
      id: okChannelId,
      orgId,
      kind: "webhook",
      name: "Test webhook (200)",
      config: { url: okUrl, secret: WEBHOOK_SECRET },
      enabled: true,
    },
    {
      id: failChannelId,
      orgId,
      kind: "webhook",
      name: "Test webhook (500)",
      config: { url: failUrl, secret: WEBHOOK_SECRET },
      enabled: true,
    },
  ]);
  await db.insert(alertSubscriptionsTable).values([
    {
      id: okSubscriptionId,
      orgId,
      userId,
      channelId: okChannelId,
      severityThreshold: "low",
      sources: null,
      watchlistId: null,
      digest: "realtime",
      enabled: true,
    },
    {
      id: failSubscriptionId,
      orgId,
      userId,
      channelId: failChannelId,
      severityThreshold: "low",
      sources: null,
      watchlistId: null,
      digest: "realtime",
      enabled: true,
    },
  ]);
});

test.after(async () => {
  // Cascade deletes channels, subscriptions, deliveries, alerts via
  // the org_id FKs. Tear down sockets last so any in-flight responses
  // don't error on a closed handle.
  await db.delete(orgsTable).where(eq(orgsTable.id, orgId));
  await stopReceiver(okServer);
  await stopReceiver(failServer);
  await pool.end();
});

/**
 * Assert the captured request matches the wire contract every webhook
 * receiver depends on: POST + JSON content-type, sha256-prefixed
 * signature header that round-trips through `verifyWebhookSignature`,
 * a numeric timestamp header that matches the timestamp embedded in
 * the JSON envelope, and an alert-id header matching the persisted row.
 *
 * Shared between the happy-path and failure-path tests so both pin
 * the same headers/body shape — a regression that broke them only on
 * the failure path (e.g. dropping headers when we already know the
 * receiver will 500) would otherwise slip past.
 */
function assertSignedWebhookCapture(
  cap: Capture,
  expected: { alertId: string; severity: string; kind: string },
): void {
  assert.equal(cap.method, "POST", "webhook deliveries must use POST");
  assert.equal(
    String(cap.headers["content-type"]).toLowerCase(),
    "application/json",
    `content-type must be application/json, got ${cap.headers["content-type"]}`,
  );
  const sigHeader = cap.headers["x-procuro-signature"];
  assert.equal(typeof sigHeader, "string", "x-procuro-signature must be set");
  const sigValue = String(sigHeader);
  assert.ok(
    sigValue.startsWith("sha256="),
    `signature header must be sha256-prefixed, got "${sigValue}"`,
  );
  const sigHex = sigValue.slice("sha256=".length);
  assert.equal(
    verifyWebhookSignature(cap.body, WEBHOOK_SECRET, sigHex),
    true,
    "receiver must be able to verify the signature against the raw body",
  );
  const tsHeader = String(cap.headers["x-procuro-timestamp"]);
  assert.match(tsHeader, /^\d+$/, "timestamp must be a unix-seconds integer");
  assert.equal(
    cap.headers["x-procuro-alert-id"],
    expected.alertId,
    "alert id header must match the persisted alert row",
  );
  const parsed = JSON.parse(cap.body) as {
    timestamp: number;
    alert: { id: string; severity: string; kind: string };
  };
  assert.equal(parsed.timestamp, Number(tsHeader));
  assert.equal(parsed.alert.id, expected.alertId);
  assert.equal(parsed.alert.severity, expected.severity);
  assert.equal(parsed.alert.kind, expected.kind);
}

test("deliverAlertsTick POSTs a signed envelope to a real webhook receiver and marks the delivery sent", async () => {
  // A unique kind so we can find this alert (and only this alert) by
  // org + kind without depending on titles or IDs leaking outside this
  // test.
  const kind = `${RUN}_ok`;
  const alertCreate = await createAlert({
    orgId,
    severity: "high",
    source: "sanctions",
    kind,
    title: `${RUN} happy path alert`,
    summary: "An alert that should reach the receiver and verify.",
    payload: { sources: [], note: "ok-path" },
  });
  const alertId = alertCreate.alert.id;

  // Snapshot pre-tick capture counts so the per-test asserts are
  // immune to other tests in the same file/run.
  const okBefore = okCaptures.length;

  const result = await deliverAlertsTick();

  // The tick may also process unrelated alerts seeded by other tests
  // running against the shared DB, so we assert lower bounds here and
  // pin the per-row contract via direct DB reads below.
  assert.ok(
    result.alertsConsidered >= 1,
    `tick should have considered at least one alert; got ${result.alertsConsidered}`,
  );
  assert.ok(
    result.deliveriesSent >= 1,
    `tick should have sent at least one webhook; got ${result.deliveriesSent}`,
  );

  // Exactly one new request hit the OK receiver for this alert.
  assert.equal(
    okCaptures.length - okBefore,
    1,
    "OK receiver must have been hit exactly once for this alert",
  );
  assertSignedWebhookCapture(okCaptures[okBefore]!, {
    alertId,
    severity: "high",
    kind,
  });

  // Persisted side: OK delivery row must be sent, event log must
  // reflect `delivered` with HTTP 200.
  const [okDelivery] = await db
    .select()
    .from(alertDeliveriesTable)
    .where(
      and(
        eq(alertDeliveriesTable.alertId, alertId),
        eq(alertDeliveriesTable.channelId, okChannelId),
      ),
    );
  assert.ok(okDelivery, "expected an alert_deliveries row for the OK channel");
  assert.equal(okDelivery!.state, "sent", "OK delivery state must be 'sent'");
  assert.equal(okDelivery!.attempts, 1, "OK delivery attempts must be 1");
  assert.ok(okDelivery!.sentAt instanceof Date, "OK delivery must have sentAt");
  assert.equal(
    okDelivery!.lastError,
    null,
    "OK delivery must clear lastError on success",
  );

  const deliveredEvents = (
    await db
      .select()
      .from(alertEventsTable)
      .where(eq(alertEventsTable.alertId, alertId))
  ).filter(
    (e) =>
      e.eventType === "delivered" &&
      (e.metadata as { channelId?: string }).channelId === okChannelId,
  );
  assert.equal(
    deliveredEvents.length,
    1,
    "expected exactly one 'delivered' event for the OK channel",
  );
  const deliveredMeta = deliveredEvents[0]!.metadata as Record<string, unknown>;
  assert.equal(deliveredMeta["channelKind"], "webhook");
  assert.equal(deliveredMeta["status"], "delivered");
  assert.equal(deliveredMeta["httpStatus"], 200);
});

test("deliverAlertsTick marks the delivery failed and records the HTTP status when the receiver returns 500", async () => {
  // Self-contained: create our own alert, drive a tick, and assert on
  // the failing channel's delivery row + event for THIS alert. Doing
  // its own create + tick decouples this test from any prior ordering.
  const kind = `${RUN}_fail`;
  const alertCreate = await createAlert({
    orgId,
    severity: "critical",
    source: "sanctions",
    kind,
    title: `${RUN} failure path alert`,
    summary: "An alert whose webhook receiver always 500s.",
    payload: { sources: [], note: "fail-path" },
  });
  const alertId = alertCreate.alert.id;

  const failBefore = failCaptures.length;

  const result = await deliverAlertsTick();
  assert.ok(
    result.deliveriesFailed >= 1,
    `tick should have recorded at least one failed delivery; got ${result.deliveriesFailed}`,
  );

  // The failing receiver must have been hit exactly once for this
  // alert and the request payload must be just as well-formed as the
  // happy path — broken receivers don't get to break our wire contract.
  assert.equal(
    failCaptures.length - failBefore,
    1,
    "FAIL receiver must have been hit exactly once for this alert",
  );
  assertSignedWebhookCapture(failCaptures[failBefore]!, {
    alertId,
    severity: "critical",
    kind,
  });

  const [failedDelivery] = await db
    .select()
    .from(alertDeliveriesTable)
    .where(
      and(
        eq(alertDeliveriesTable.alertId, alertId),
        eq(alertDeliveriesTable.channelId, failChannelId),
      ),
    );
  assert.ok(
    failedDelivery,
    "expected an alert_deliveries row for the FAIL channel",
  );
  assert.equal(
    failedDelivery!.state,
    "failed",
    "FAIL delivery state must be 'failed'",
  );
  assert.equal(failedDelivery!.attempts, 1, "FAIL delivery attempts must be 1");
  assert.ok(
    typeof failedDelivery!.lastError === "string" &&
      /500/.test(failedDelivery!.lastError),
    `FAIL delivery lastError must reference HTTP 500, got ${JSON.stringify(failedDelivery!.lastError)}`,
  );
  assert.equal(
    failedDelivery!.sentAt,
    null,
    "FAIL delivery must NOT set sentAt",
  );

  // And there must be a `delivery_failed` event on the same alert
  // recording the HTTP status — this is what the inbox + jobs UI
  // surface to operators triaging a broken endpoint.
  const failedEvents = (
    await db
      .select()
      .from(alertEventsTable)
      .where(eq(alertEventsTable.alertId, alertId))
  ).filter(
    (e) =>
      e.eventType === "delivery_failed" &&
      (e.metadata as { channelId?: string }).channelId === failChannelId,
  );
  assert.equal(
    failedEvents.length,
    1,
    `expected exactly one 'delivery_failed' event for the FAIL channel, got ${failedEvents.length}`,
  );
  const meta = failedEvents[0]!.metadata as Record<string, unknown>;
  assert.equal(meta["channelKind"], "webhook");
  assert.equal(meta["httpStatus"], 500);
});
