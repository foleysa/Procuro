/**
 * Integration test for the NetSuite adapter end-to-end:
 *
 *   - mock `fetch` so we never hit the network,
 *   - drive `netsuiteConnector.fetchAll` with a fake OAuth token endpoint
 *     and three paged entity responses,
 *   - assert the resulting `IngestPayload` has the expected shape and
 *     row counts,
 *   - assert per-entity watermarks advance to the max `lastModifiedDate`
 *     we served, and a second call with that watermark forwards the
 *     `?q=lastModifiedDate AFTER "..."` query parameter as expected (no
 *     duplicate ingest).
 *
 * No DB required — we only exercise the connector's HTTP/parsing
 * boundary. The downstream `writeIngestPayload` path is covered by the
 * existing CSV ingest tests.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { netsuiteConnector } from "../src/lib/connectors/netsuite/adapter";

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
  accountId: "1234567",
  pageSize: 200,
  scope: "rest_webservices",
};
const credentials = { clientId: "id-1", clientSecret: "sec-1" };

describe("netsuite connector fetchAll (mocked HTTP)", () => {
  it("authenticates, fetches each entity, and advances watermarks", async () => {
    const { fetchImpl, calls } = mockFetch((req) => {
      if (req.url.endsWith("/services/rest/auth/oauth2/v1/token")) {
        return {
          body: { access_token: "tok-abc", expires_in: 3600 },
        };
      }
      if (req.url.includes("/services/rest/record/v1/vendor?")) {
        return {
          body: {
            items: [
              {
                id: 1,
                companyName: "S One",
                countryCode: "US",
                isPreferred: true,
                lastModifiedDate: "2026-04-01T00:00:00Z",
              },
              {
                id: 2,
                companyName: "S Two",
                lastModifiedDate: "2026-04-02T00:00:00Z",
              },
            ],
            hasMore: false,
          },
        };
      }
      if (req.url.includes("/services/rest/record/v1/contract")) {
        return {
          body: {
            items: [
              {
                id: 11,
                tranid: "C-11",
                vendor: { id: 1 },
                startDate: "2026-01-01",
                endDate: "2026-12-31",
                lastModifiedDate: "2026-03-15T00:00:00Z",
              },
            ],
            hasMore: false,
          },
        };
      }
      if (req.url.includes("/services/rest/record/v1/purchaseOrder")) {
        return {
          body: {
            items: [
              {
                id: 21,
                tranid: "PO-21",
                entity: { id: 1 },
                tranDate: "2026-04-10T00:00:00Z",
                item: { items: [] },
                lastModifiedDate: "2026-04-10T00:00:00Z",
              },
            ],
            hasMore: false,
          },
        };
      }
      if (req.url.includes("/services/rest/record/v1/vendorBill")) {
        return { body: { items: [], hasMore: false } };
      }
      if (req.url.includes("/services/rest/record/v1/vendorPayment")) {
        return { body: { items: [], hasMore: false } };
      }
      return { status: 404, body: { error: "unknown" } };
    });

    const result = await netsuiteConnector.fetchAll({
      orgId: "org-test",
      connectionId: "conn-test",
      credentials,
      settings,
      watermarks: {},
      fetchImpl,
    });

    // Token exchange happened first against the derived host.
    assert.equal(
      calls[0]!.url,
      "https://1234567.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token",
    );
    assert.equal(calls[0]!.method, "POST");
    assert.match(calls[0]!.body ?? "", /grant_type=client_credentials/);
    assert.match(calls[0]!.body ?? "", /client_id=id-1/);

    // Exactly one page per entity (5 entity GETs).
    const getCalls = calls.filter((c) => c.method === "GET");
    assert.equal(getCalls.length, 5);
    for (const c of getCalls) {
      assert.equal(c.headers["authorization"], "Bearer tok-abc");
    }

    // Payload shape.
    assert.equal(result.payload.suppliers!.length, 2);
    assert.equal(result.payload.suppliers![0]!.externalId, "1");
    assert.equal(result.payload.suppliers![0]!.countryCode, "US");
    assert.equal(result.payload.contracts!.length, 1);
    assert.equal(result.payload.contracts![0]!.contractNumber, "C-11");
    assert.equal(result.payload.purchaseOrders!.length, 1);

    // Watermarks advanced to the max `lastModifiedDate` per entity.
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

  it("forwards the previous watermark as a SuiteQL `q` filter on the next call", async () => {
    const { fetchImpl, calls } = mockFetch((req) => {
      if (req.url.endsWith("/services/rest/auth/oauth2/v1/token")) {
        return { body: { access_token: "tok-xyz", expires_in: 3600 } };
      }
      return { body: { items: [], hasMore: false } };
    });

    await netsuiteConnector.fetchAll({
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
      c.url.includes("/services/rest/record/v1/vendor?"),
    );
    assert.ok(supplierCall);
    assert.match(
      supplierCall!.url,
      /q=lastModifiedDate(\+|%20)AFTER(\+|%20)%222026-04-02T00%3A00%3A00.000Z%22/,
    );
    const contractCall = calls.find((c) =>
      c.url.includes("/services/rest/record/v1/contract"),
    );
    assert.ok(contractCall);
    assert.match(
      contractCall!.url,
      /q=lastModifiedDate(\+|%20)AFTER(\+|%20)%222026-03-15T00%3A00%3A00.000Z%22/,
    );
  });

  it("derives the host from the account id (sandbox suffix is normalised)", async () => {
    const { fetchImpl, calls } = mockFetch((req) => {
      if (req.url.includes("/services/rest/auth/oauth2/v1/token")) {
        return { body: { access_token: "tok-sb", expires_in: 3600 } };
      }
      return { body: { items: [], hasMore: false } };
    });

    await netsuiteConnector.fetchAll({
      orgId: "org-test",
      connectionId: "conn-test",
      credentials,
      settings: { ...settings, accountId: "1234567_SB1" },
      watermarks: {},
      fetchImpl,
    });
    assert.match(
      calls[0]!.url,
      /^https:\/\/1234567-sb1\.suitetalk\.api\.netsuite\.com\//,
    );
  });

  it("testConnection returns ok=false on a 401 from the token endpoint", async () => {
    const { fetchImpl } = mockFetch(() => ({
      status: 401,
      body: { error: "invalid_client" },
    }));
    const out = await netsuiteConnector.testConnection({
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
    const out = await netsuiteConnector.testConnection({
      credentials,
      settings,
      fetchImpl,
    });
    assert.equal(out.ok, true);
  });
});
