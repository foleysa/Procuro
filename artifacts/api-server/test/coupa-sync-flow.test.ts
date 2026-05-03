/**
 * Integration test for the Coupa adapter end-to-end:
 *
 *   - mock `fetch` so we never hit the network,
 *   - drive `coupaConnector.fetchAll` with a fake OAuth token endpoint
 *     and three paged entity responses,
 *   - assert the resulting `IngestPayload` has the expected shape and
 *     row counts,
 *   - assert per-entity watermarks advance to the max `updatedAt` we
 *     served, and a second call with that watermark forwards the
 *     `?updated-at[gt]=...` query parameter as expected (no duplicate
 *     ingest).
 *
 * No DB required — we only exercise the connector's HTTP/parsing
 * boundary. The downstream `writeIngestPayload` path is covered by the
 * existing CSV ingest tests.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { coupaConnector } from "../src/lib/connectors/coupa/adapter";

interface RecordedRequest {
  url: string;
  method: string;
  body?: string;
  headers: Record<string, string>;
}

function mockFetch(
  responder: (req: RecordedRequest) => { status?: number; body: unknown },
): { fetchImpl: typeof fetch; calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const k of Object.keys(h)) headers[k.toLowerCase()] = h[k]!;
    }
    let body: string | undefined;
    if (init?.body) {
      body =
        init.body instanceof URLSearchParams
          ? init.body.toString()
          : String(init.body);
    }
    const rec: RecordedRequest = { url, method, body, headers };
    calls.push(rec);
    const { status = 200, body: responseBody } = responder(rec);
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, calls };
}

const settings = {
  instanceUrl: "https://acme.coupahost.com",
  pageSize: 200,
  scope:
    "core.supplier.read core.contract.read core.purchase_order.read core.invoice.read core.payment.read",
};
const credentials = { clientId: "id-1", clientSecret: "sec-1" };

describe("coupa connector fetchAll (mocked HTTP)", () => {
  it("authenticates, fetches each entity, and advances watermarks", async () => {
    const { fetchImpl, calls } = mockFetch((req) => {
      if (req.url.endsWith("/oauth2/token")) {
        return {
          body: { access_token: "tok-abc", expires_in: 3600 },
        };
      }
      if (req.url.includes("/api/suppliers")) {
        return {
          body: [
            {
              id: 1,
              name: "S One",
              "country-code": "US",
              preferred: true,
              "updated-at": "2026-04-01T00:00:00Z",
            },
            {
              id: 2,
              name: "S Two",
              "updated-at": "2026-04-02T00:00:00Z",
            },
          ],
        };
      }
      if (req.url.includes("/api/contracts")) {
        // Two rows exercising both Coupa parent-link wire variants:
        //   - row 11 has `parent-id` (procurement-contracts module)
        //   - row 12 has `master-agreement-id` (legal-contracts module)
        // The adapter must collapse both onto `parentContractId` so
        // mapContract emits `msaParentExternalId` and the writer's
        // second-pass MSA resolver populates `msa_parent_id`.
        return {
          body: [
            {
              id: 11,
              number: "C-11",
              "supplier-id": 1,
              "parent-id": 99,
              "start-date": "2026-01-01",
              "end-date": "2026-12-31",
              "updated-at": "2026-03-15T00:00:00Z",
            },
            {
              id: 12,
              number: "C-12",
              "supplier-id": 1,
              "master-agreement-id": 98,
              "start-date": "2026-02-01",
              "end-date": "2026-11-30",
              "updated-at": "2026-03-10T00:00:00Z",
            },
          ],
        };
      }
      if (req.url.includes("/api/purchase_orders")) {
        return {
          body: [
            {
              id: 21,
              "po-number": "PO-21",
              "supplier-id": 1,
              "order-date": "2026-04-10T00:00:00Z",
              lines: [],
              "updated-at": "2026-04-10T00:00:00Z",
            },
          ],
        };
      }
      if (req.url.includes("/api/invoices")) {
        return { body: [] };
      }
      if (req.url.includes("/api/payments")) {
        return { body: [] };
      }
      if (req.url.includes("/api/statements_of_work")) {
        return {
          body: [
            {
              id: 31,
              number: "SOW-31",
              name: "Q2 Build",
              "contract-id": 11,
              "supplier-id": 1,
              status: "in_progress",
              "start-date": "2026-04-01",
              "end-date": "2026-09-30",
              "total-value": { value: "75000", "currency-code": "USD" },
              milestones: [
                {
                  number: 1,
                  name: "Discovery",
                  "due-date": "2026-05-01",
                  status: "delivered",
                },
              ],
              "updated-at": "2026-04-12T00:00:00Z",
            },
          ],
        };
      }
      if (req.url.includes("/api/rate_cards")) {
        return {
          body: [
            {
              id: 41,
              name: "FY26 Rates",
              "supplier-id": 1,
              "sow-id": 31,
              "currency-code": "USD",
              "effective-date": "2026-04-01",
              "expiry-date": "2027-03-31",
              lines: [{ role: "Senior Engineer", "hourly-rate": "275" }],
              "updated-at": "2026-04-13T00:00:00Z",
            },
          ],
        };
      }
      if (req.url.includes("/api/time_entries")) {
        return {
          body: [
            {
              id: 51,
              "supplier-id": 1,
              "sow-id": 31,
              "rate-card-id": 41,
              resource: "Jane Consultant",
              role: "Senior Engineer",
              "work-date": "2026-04-15",
              hours: "8",
              "bill-rate": { value: "275", "currency-code": "USD" },
              amount: { value: "2200", "currency-code": "USD" },
              "updated-at": "2026-04-15T18:00:00Z",
            },
          ],
        };
      }
      return { status: 404, body: { error: "unknown" } };
    });

    const result = await coupaConnector.fetchAll({
      orgId: "org-test",
      connectionId: "conn-test",
      credentials,
      settings,
      watermarks: {},
      fetchImpl,
    });

    // Token exchange happened first.
    assert.equal(calls[0]!.url, "https://acme.coupahost.com/oauth2/token");
    assert.equal(calls[0]!.method, "POST");
    assert.match(calls[0]!.body ?? "", /grant_type=client_credentials/);
    assert.match(calls[0]!.body ?? "", /client_id=id-1/);

    // Exactly one page per entity (8 entity GETs: 5 base + SOW/RC/TE).
    const getCalls = calls.filter((c) => c.method === "GET");
    assert.equal(getCalls.length, 8);
    for (const c of getCalls) {
      assert.equal(c.headers["authorization"], "Bearer tok-abc");
    }

    // Payload shape.
    assert.equal(result.payload.suppliers!.length, 2);
    assert.equal(result.payload.suppliers![0]!.externalId, "1");
    assert.equal(result.payload.suppliers![0]!.countryCode, "US");
    assert.equal(result.payload.contracts!.length, 2);
    assert.equal(result.payload.contracts![0]!.contractNumber, "C-11");
    // `parent-id` (procurement module) → msaParentExternalId.
    assert.equal(result.payload.contracts![0]!.msaParentExternalId, "99");
    // `master-agreement-id` (legal module) → msaParentExternalId.
    assert.equal(result.payload.contracts![1]!.contractNumber, "C-12");
    assert.equal(result.payload.contracts![1]!.msaParentExternalId, "98");
    assert.equal(result.payload.purchaseOrders!.length, 1);

    // Task #232 — services-spend taxonomy round-trips through the
    // mapper and lands on the canonical IngestPayload shape.
    assert.equal(result.payload.statementsOfWork!.length, 1);
    assert.equal(result.payload.statementsOfWork![0]!.sowNumber, "SOW-31");
    assert.equal(
      result.payload.statementsOfWork![0]!.contractExternalId,
      "11",
    );
    assert.equal(result.payload.statementsOfWork![0]!.status, "active");
    assert.equal(result.payload.statementsOfWork![0]!.totalValueUsd, 75000);
    assert.equal(result.payload.statementsOfWork![0]!.milestones?.length, 1);
    assert.equal(result.payload.rateCards!.length, 1);
    assert.equal(result.payload.rateCards![0]!.sowExternalId, "31");
    assert.equal(result.payload.rateCards![0]!.lines?.length, 1);
    assert.equal(result.payload.rateCards![0]!.lines![0]!.hourlyRate, 275);
    assert.equal(result.payload.timeEntries!.length, 1);
    assert.equal(result.payload.timeEntries![0]!.hours, 8);
    assert.equal(result.payload.timeEntries![0]!.sowExternalId, "31");
    assert.equal(result.payload.timeEntries![0]!.rateCardExternalId, "41");

    // Watermarks advanced to the max `updated-at` per entity.
    assert.equal(
      result.nextWatermarks["suppliers"],
      "2026-04-02T00:00:00.000Z",
    );
    assert.equal(
      result.nextWatermarks["contracts"],
      "2026-03-15T00:00:00.000Z",
    );
    assert.equal(
      result.nextWatermarks["purchase_orders"],
      "2026-04-10T00:00:00.000Z",
    );
    assert.equal(
      result.nextWatermarks["statements_of_work"],
      "2026-04-12T00:00:00.000Z",
    );
    assert.equal(
      result.nextWatermarks["rate_cards"],
      "2026-04-13T00:00:00.000Z",
    );
    assert.equal(
      result.nextWatermarks["time_entries"],
      "2026-04-15T18:00:00.000Z",
    );
    // Entities with no rows leave the watermark unset.
    assert.equal(result.nextWatermarks["invoices"], undefined);
    assert.equal(result.nextWatermarks["payments"], undefined);

    // Per-entity counters land in the result.
    assert.equal(result.recordsByEntity.suppliers, 2);
    assert.equal(result.recordsByEntity.contracts, 2);
    assert.equal(result.recordsByEntity.statements_of_work, 1);
    assert.equal(result.recordsByEntity.rate_cards, 1);
    assert.equal(result.recordsByEntity.time_entries, 1);
  });

  it("forwards the previous watermark as ?updated-at[gt] on the next call", async () => {
    const { fetchImpl, calls } = mockFetch((req) => {
      if (req.url.endsWith("/oauth2/token")) {
        return { body: { access_token: "tok-xyz", expires_in: 3600 } };
      }
      return { body: [] };
    });

    await coupaConnector.fetchAll({
      orgId: "org-test",
      connectionId: "conn-test",
      credentials,
      settings,
      watermarks: {
        suppliers: "2026-04-02T00:00:00.000Z",
        contracts: "2026-03-15T00:00:00.000Z",
      },
      fetchImpl,
    });

    const supplierCall = calls.find((c) => c.url.includes("/api/suppliers"));
    assert.ok(supplierCall);
    assert.match(
      supplierCall!.url,
      /updated-at(%5B|\[)gt(%5D|\])=2026-04-02T00%3A00%3A00.000Z/,
    );
    const contractCall = calls.find((c) => c.url.includes("/api/contracts"));
    assert.match(
      contractCall!.url,
      /updated-at(%5B|\[)gt(%5D|\])=2026-03-15T00%3A00%3A00.000Z/,
    );
  });

  it("testConnection returns ok=false on a 401 from the token endpoint", async () => {
    const { fetchImpl } = mockFetch(() => ({
      status: 401,
      body: { error: "invalid_client" },
    }));
    const out = await coupaConnector.testConnection({
      credentials,
      settings,
      fetchImpl,
    });
    assert.equal(out.ok, false);
    if (out.ok === false) {
      assert.match(out.error, /401/);
    }
  });

  it("testConnection returns ok=true when the token request succeeds", async () => {
    const { fetchImpl } = mockFetch(() => ({
      body: { access_token: "tok-ok", expires_in: 3600 },
    }));
    const out = await coupaConnector.testConnection({
      credentials,
      settings,
      fetchImpl,
    });
    assert.equal(out.ok, true);
  });
});
