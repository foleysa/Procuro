/**
 * Integration test for the SAP Ariba adapter end-to-end:
 *
 *   - mock `fetch` so we never hit the network,
 *   - drive `aribaConnector.fetchAll` with a fake OAuth token endpoint
 *     and three paged entity responses,
 *   - assert the resulting `IngestPayload` has the expected shape and
 *     row counts,
 *   - assert per-entity watermarks advance to the max `lastUpdatedTime`
 *     we served, and a second call with that watermark forwards the
 *     `?$filter=lastUpdatedTime gt ...` query parameter as expected (no
 *     duplicate ingest).
 *
 * No DB required — we only exercise the connector's HTTP/parsing
 * boundary. The downstream `writeIngestPayload` path is covered by the
 * existing CSV ingest tests.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { aribaConnector } from "../src/lib/connectors/ariba/adapter";

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
  instanceUrl: "https://openapi.ariba.com",
  realm: "acme-prod",
  authUrl: "https://api.ariba.com",
  pageSize: 200,
};
const credentials = {
  apiKey: "key-1",
  clientId: "id-1",
  clientSecret: "sec-1",
};

describe("ariba connector fetchAll (mocked HTTP)", () => {
  it("authenticates, fetches each entity, and advances watermarks", async () => {
    const { fetchImpl, calls } = mockFetch((req) => {
      if (req.url.endsWith("/v2/oauth/token")) {
        return {
          body: { access_token: "tok-abc", expires_in: 3600 },
        };
      }
      if (req.url.includes("/api/sourcing/v1/suppliers")) {
        return {
          body: {
            items: [
              {
                internalId: "AN-1",
                name: "S One",
                country: "US",
                preferred: true,
                lastUpdatedTime: "2026-04-01T00:00:00Z",
              },
              {
                internalId: "AN-2",
                name: "S Two",
                lastUpdatedTime: "2026-04-02T00:00:00Z",
              },
            ],
          },
        };
      }
      if (req.url.includes("/api/contracts/v1/contracts")) {
        return {
          body: {
            items: [
              {
                internalId: "WS-11",
                documentNumber: "C-11",
                supplierInternalId: "AN-1",
                effectiveDate: "2026-01-01",
                expirationDate: "2026-12-31",
                lastUpdatedTime: "2026-03-15T00:00:00Z",
              },
            ],
          },
        };
      }
      if (req.url.includes("/api/procurement/v1/purchaseOrders")) {
        return {
          body: {
            items: [
              {
                internalId: "PO-INT-21",
                documentNumber: "PO-21",
                supplierInternalId: "AN-1",
                orderDate: "2026-04-10T00:00:00Z",
                lineItems: [],
                lastUpdatedTime: "2026-04-10T00:00:00Z",
              },
            ],
          },
        };
      }
      if (req.url.includes("/api/procurement/v1/invoices")) {
        return { body: { items: [] } };
      }
      if (req.url.includes("/api/procurement/v1/payments")) {
        return { body: { items: [] } };
      }
      return { status: 404, body: { error: "unknown" } };
    });

    const result = await aribaConnector.fetchAll({
      orgId: "org-test",
      connectionId: "conn-test",
      credentials,
      settings,
      watermarks: {},
      fetchImpl,
    });

    // Token exchange happened first against the auth host with Basic auth.
    assert.equal(calls[0]!.url, "https://api.ariba.com/v2/oauth/token");
    assert.equal(calls[0]!.method, "POST");
    assert.match(calls[0]!.headers["authorization"] ?? "", /^Basic /);
    assert.equal(calls[0]!.headers["apikey"], "key-1");
    assert.match(calls[0]!.body ?? "", /grant_type=client_credentials/);

    // Exactly one page per entity (5 entity GETs).
    const getCalls = calls.filter((c) => c.method === "GET");
    assert.equal(getCalls.length, 5);
    for (const c of getCalls) {
      assert.equal(c.headers["authorization"], "Bearer tok-abc");
      assert.equal(c.headers["apikey"], "key-1");
      assert.match(c.url, /realm=acme-prod/);
    }

    // Payload shape.
    assert.equal(result.payload.suppliers!.length, 2);
    assert.equal(result.payload.suppliers![0]!.externalId, "AN-1");
    assert.equal(result.payload.suppliers![0]!.countryCode, "US");
    assert.equal(result.payload.contracts!.length, 1);
    assert.equal(result.payload.contracts![0]!.contractNumber, "C-11");
    assert.equal(result.payload.purchaseOrders!.length, 1);

    // Watermarks advanced to the max `lastUpdatedTime` per entity.
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
    // Entities with no rows leave the watermark unset.
    assert.equal(result.nextWatermarks["invoices"], undefined);
    assert.equal(result.nextWatermarks["payments"], undefined);

    assert.equal(result.recordsByEntity.suppliers, 2);
    assert.equal(result.recordsByEntity.contracts, 1);
  });

  it("forwards the previous watermark as an OData $filter on the next call", async () => {
    const { fetchImpl, calls } = mockFetch((req) => {
      if (req.url.endsWith("/v2/oauth/token")) {
        return { body: { access_token: "tok-xyz", expires_in: 3600 } };
      }
      return { body: { items: [] } };
    });

    await aribaConnector.fetchAll({
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

    const supplierCall = calls.find((c) =>
      c.url.includes("/api/sourcing/v1/suppliers"),
    );
    assert.ok(supplierCall);
    assert.match(
      supplierCall!.url,
      /%24filter=lastUpdatedTime(\+|%20)gt(\+|%20)2026-04-02T00%3A00%3A00.000Z/,
    );
    const contractCall = calls.find((c) =>
      c.url.includes("/api/contracts/v1/contracts"),
    );
    assert.ok(contractCall);
    assert.match(
      contractCall!.url,
      /%24filter=lastUpdatedTime(\+|%20)gt(\+|%20)2026-03-15T00%3A00%3A00.000Z/,
    );
  });

  it("testConnection returns ok=false on a 401 from the token endpoint", async () => {
    const { fetchImpl } = mockFetch(() => ({
      status: 401,
      body: { error: "invalid_client" },
    }));
    const out = await aribaConnector.testConnection({
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
    const out = await aribaConnector.testConnection({
      credentials,
      settings,
      fetchImpl,
    });
    assert.equal(out.ok, true);
  });
});
