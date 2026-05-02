/**
 * Unit tests for the NetSuite → IngestPayload mapping. Pure functions,
 * no I/O — pinning the field-by-field transformation against captured
 * fixtures so a regression in the connector doesn't silently corrupt a
 * tenant's procurement data on the next sync.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildIngestPayload,
  mapContract,
  mapInvoice,
  mapPayment,
  mapPurchaseOrder,
  mapVendor,
  type NetSuiteContract,
  type NetSuiteInvoice,
  type NetSuitePayment,
  type NetSuitePurchaseOrder,
  type NetSuiteVendor,
} from "../src/lib/connectors/netsuite/mapping";

describe("netsuite mapping", () => {
  it("maps a vendor with optional fields preserved", () => {
    const wire: NetSuiteVendor = {
      id: 7421,
      entityId: "V-7421",
      companyName: "Acme Components",
      countryCode: "US",
      currency: { symbol: "USD" },
      terms: { refName: "Net 30", daysUntilNetDue: 30 },
      isPreferred: true,
      category: { refName: "strategic" },
      lastModifiedDate: "2026-04-01T10:00:00Z",
    };
    const out = mapVendor(wire);
    assert.equal(out.externalId, "7421");
    assert.equal(out.name, "Acme Components");
    assert.equal(out.countryCode, "US");
    assert.equal(out.billingCurrency, "USD");
    assert.equal(out.paymentTermsDays, "30");
    assert.equal(out.isPreferred, true);
    assert.deepEqual(out.tags, ["strategic"]);
  });

  it("vendor mapper falls back to entityId / synthetic name and defaults flags", () => {
    const out = mapVendor({ id: 1 });
    assert.equal(out.externalId, "1");
    assert.equal(out.name, "vendor-1");
    assert.equal(out.isPreferred, false);
    assert.equal(out.isStrategic, false);
    assert.deepEqual(out.tags, []);
    const out2 = mapVendor({ id: 2, entityId: "V-2" });
    assert.equal(out2.name, "V-2");
  });

  it("contract mapper drops contracts without a vendor or dates", () => {
    const ok: NetSuiteContract = {
      id: 100,
      tranid: "C-100",
      title: "Master Services",
      vendor: { id: 7421 },
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      terms: { daysUntilNetDue: 45 },
      amount: "250000.50",
      currency: { symbol: "USD" },
      lastModifiedDate: "2026-04-01T10:00:00Z",
    };
    const okMapped = mapContract(ok);
    assert.ok(okMapped);
    assert.equal(okMapped!.supplierExternalId, "7421");
    assert.equal(okMapped!.contractNumber, "C-100");
    assert.equal(okMapped!.paymentTermsDays, 45);
    assert.equal(okMapped!.annualBaselineUsd, 250000.5);

    assert.equal(
      mapContract({ ...ok, vendor: { id: null } }),
      null,
      "missing vendor -> drop",
    );
    assert.equal(
      mapContract({ ...ok, startDate: null }),
      null,
      "missing startDate -> drop",
    );
  });

  it("PO mapper carries lines, infers spend class from itemType", () => {
    const wire: NetSuitePurchaseOrder = {
      id: 555,
      tranid: "PO-555",
      entity: { id: 7421 },
      contract: { id: 100 },
      tranDate: "2026-04-15T00:00:00Z",
      total: 2500,
      currency: { symbol: "USD" },
      item: {
        items: [
          {
            line: 1,
            itemId: "STL-001",
            description: "Steel sheet",
            quantity: 10,
            units: "EA",
            rate: 100,
            itemType: "InvtPart",
          },
          {
            line: 2,
            itemId: "SVC-002",
            description: "Consulting hours",
            quantity: 15,
            rate: 100,
            itemType: "Service",
          },
        ],
      },
      lastModifiedDate: "2026-04-15T01:00:00Z",
    };
    const mapped = mapPurchaseOrder(wire);
    assert.ok(mapped);
    assert.equal(mapped!.poNumber, "PO-555");
    assert.equal(mapped!.contractExternalId, "100");
    assert.equal(mapped!.lines.length, 2);
    assert.equal(mapped!.lines[0]!.spendClass, "direct");
    assert.equal(mapped!.lines[1]!.spendClass, "service");
    assert.equal(mapped!.lines[0]!.unitPriceUsd, 100);
    assert.equal(mapped!.lines[0]!.qty, 10);
  });

  it("invoice mapper normalises status and embeds dedupKey", () => {
    const base: NetSuiteInvoice = {
      id: 9001,
      tranid: "INV-9001",
      entity: { id: 7421 },
      createdFrom: { id: 555 },
      tranDate: "2026-04-20",
      total: 1000,
      currency: { symbol: "USD" },
      status: "Open",
    };
    const out = mapInvoice(base);
    assert.ok(out);
    assert.equal(out!.status, "approved");
    assert.equal(out!.dedupKey, "netsuite:9001:INV-9001");

    assert.equal(
      mapInvoice({ ...base, status: "Paid In Full" })!.status,
      "paid",
    );
    assert.equal(mapInvoice({ ...base, status: "Voided" })!.status, "void");
    assert.equal(
      mapInvoice({ ...base, status: "Pending Approval" })!.status,
      "received",
    );
    assert.equal(
      mapInvoice({ ...base, status: "Rejected" })!.status,
      "disputed",
    );
  });

  it("payment mapper preserves bill link and amount", () => {
    const wire: NetSuitePayment = {
      id: 70001,
      bill: { id: 9001 },
      tranDate: "2026-05-15T00:00:00Z",
      total: 1000,
      currency: { symbol: "USD" },
      terms: { daysUntilNetDue: 25 },
    };
    const out = mapPayment(wire);
    assert.ok(out);
    assert.equal(out!.invoiceExternalId, "9001");
    assert.equal(out!.amountUsd, 1000);
    assert.equal(out!.paymentTermsDays, 25);
  });

  it("buildIngestPayload reports per-entity drop counts", () => {
    const { payload, dropped } = buildIngestPayload({
      vendors: [
        { id: 1, companyName: "A" },
        { id: 2, companyName: "B" },
      ],
      contracts: [
        // missing vendor -> dropped
        {
          id: 10,
          tranid: "C-10",
          startDate: "2026-01-01",
          endDate: "2026-12-31",
        } as NetSuiteContract,
      ],
      invoices: [
        // missing entity -> dropped
        {
          id: 20,
          tranid: "I-20",
          tranDate: "2026-02-01",
        } as NetSuiteInvoice,
      ],
      payments: [],
      purchaseOrders: [],
    });
    assert.equal(payload.suppliers!.length, 2);
    assert.equal(payload.contracts!.length, 0);
    assert.equal(payload.invoices!.length, 0);
    assert.equal(dropped["contracts"], 1);
    assert.equal(dropped["invoices"], 1);
    assert.equal(dropped["suppliers"], 0);
  });
});
