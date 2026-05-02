/**
 * Unit tests for the SAP Ariba → IngestPayload mapping. Pure
 * functions, no I/O — pinning the field-by-field transformation
 * against captured fixtures so a regression in the connector doesn't
 * silently corrupt a tenant's procurement data on the next sync.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildIngestPayload,
  mapContract,
  mapInvoice,
  mapPayment,
  mapPurchaseOrder,
  mapSupplier,
  type AribaContract,
  type AribaInvoice,
  type AribaPayment,
  type AribaPurchaseOrder,
  type AribaSupplier,
} from "../src/lib/connectors/ariba/mapping";

describe("ariba mapping", () => {
  it("maps a supplier with optional fields preserved", () => {
    const wire: AribaSupplier = {
      internalId: "AN01000123",
      name: "Acme Components",
      country: "DE",
      baseCurrency: "EUR",
      paymentTerms: { code: "NET30", netDays: 30 },
      preferred: true,
      classifications: ["strategic", "tier-1"],
      lastUpdatedTime: "2026-04-01T10:00:00Z",
    };
    const out = mapSupplier(wire);
    assert.equal(out.externalId, "AN01000123");
    assert.equal(out.name, "Acme Components");
    assert.equal(out.countryCode, "DE");
    assert.equal(out.billingCurrency, "EUR");
    assert.equal(out.paymentTermsDays, "30");
    assert.equal(out.isPreferred, true);
    assert.deepEqual(out.tags, ["strategic", "tier-1"]);
  });

  it("supplier mapper falls back on missing name", () => {
    const out = mapSupplier({ internalId: "AN01" });
    assert.equal(out.externalId, "AN01");
    assert.equal(out.name, "supplier-AN01");
    assert.equal(out.isPreferred, false);
    assert.equal(out.isStrategic, false);
    assert.deepEqual(out.tags, []);
  });

  it("contract mapper drops contracts without a supplier or dates", () => {
    const ok: AribaContract = {
      internalId: "WS-100",
      documentNumber: "C-100",
      title: "Master Services",
      supplierInternalId: "AN01000123",
      effectiveDate: "2026-01-01",
      expirationDate: "2026-12-31",
      paymentTerms: { netDays: 45 },
      contractAmount: { amount: 250000.5, currency: "USD" },
      lastUpdatedTime: "2026-04-01T10:00:00Z",
    };
    const okMapped = mapContract(ok);
    assert.ok(okMapped);
    assert.equal(okMapped!.supplierExternalId, "AN01000123");
    assert.equal(okMapped!.paymentTermsDays, 45);
    assert.equal(okMapped!.annualBaselineUsd, 250000.5);

    assert.equal(
      mapContract({ ...ok, supplierInternalId: null }),
      null,
      "missing supplier -> drop",
    );
    assert.equal(
      mapContract({ ...ok, effectiveDate: null }),
      null,
      "missing effectiveDate -> drop",
    );
  });

  it("PO mapper carries lines and infers spend class from UNSPSC segment", () => {
    const wire: AribaPurchaseOrder = {
      internalId: "PO-INT-555",
      documentNumber: "PO-555",
      supplierInternalId: "AN01000123",
      contractInternalId: "WS-100",
      orderDate: "2026-04-15T00:00:00Z",
      totalAmount: { amount: 2500, currency: "USD" },
      lineItems: [
        {
          lineNumber: 1,
          partNumber: "STL-001",
          itemDescription: "Steel sheet",
          quantity: 10,
          unitOfMeasure: "EA",
          unitPrice: { amount: 100, currency: "USD" },
          // UNSPSC segment 11 = Mineral / Textile / raw materials → direct.
          commodity: { code: "11162400", description: "Steel" },
        },
        {
          lineNumber: 2,
          partNumber: "SVC-002",
          itemDescription: "Consulting hours",
          quantity: 15,
          unitPrice: { amount: 100, currency: "USD" },
          // UNSPSC segment 80 = Management & business services → service.
          commodity: { code: "80101500", description: "Strategy Consulting" },
        },
        {
          lineNumber: 3,
          partNumber: "OFF-003",
          itemDescription: "Office paper",
          quantity: 5,
          unitPrice: { amount: 20, currency: "USD" },
          // UNSPSC segment 44 = Office supplies → indirect.
          commodity: { code: "44121706", description: "Copier paper" },
        },
      ],
      lastUpdatedTime: "2026-04-15T01:00:00Z",
    };
    const mapped = mapPurchaseOrder(wire);
    assert.ok(mapped);
    assert.equal(mapped!.poNumber, "PO-555");
    assert.equal(mapped!.contractExternalId, "WS-100");
    assert.equal(mapped!.lines.length, 3);
    assert.equal(mapped!.lines[0]!.spendClass, "direct");
    assert.equal(mapped!.lines[1]!.spendClass, "service");
    assert.equal(mapped!.lines[2]!.spendClass, "indirect");
  });

  it("invoice mapper normalises status and embeds dedupKey", () => {
    const base: AribaInvoice = {
      internalId: "INV-INT-9001",
      documentNumber: "INV-9001",
      supplierInternalId: "AN01000123",
      poInternalId: "PO-INT-555",
      invoiceDate: "2026-04-20",
      totalAmount: { amount: 1000, currency: "USD" },
      status: "RECONCILING",
    };
    const out = mapInvoice(base);
    assert.ok(out);
    assert.equal(out!.status, "received");
    assert.equal(out!.dedupKey, "ariba:INV-INT-9001:INV-9001");

    assert.equal(mapInvoice({ ...base, status: "PAID" })!.status, "paid");
    assert.equal(
      mapInvoice({ ...base, status: "REJECTED" })!.status,
      "disputed",
    );
    assert.equal(
      mapInvoice({ ...base, status: "CANCELLED" })!.status,
      "void",
    );
    assert.equal(
      mapInvoice({ ...base, status: "APPROVED" })!.status,
      "approved",
    );
  });

  it("payment mapper preserves invoice link and amount", () => {
    const wire: AribaPayment = {
      internalId: "PAY-70001",
      invoiceInternalId: "INV-INT-9001",
      paymentDate: "2026-05-15T00:00:00Z",
      totalAmount: { amount: 1000, currency: "USD" },
      paymentTerms: { netDays: 25 },
    };
    const out = mapPayment(wire);
    assert.ok(out);
    assert.equal(out!.invoiceExternalId, "INV-INT-9001");
    assert.equal(out!.amountUsd, 1000);
    assert.equal(out!.paymentTermsDays, 25);
  });

  it("buildIngestPayload reports per-entity drop counts", () => {
    const { payload, dropped } = buildIngestPayload({
      suppliers: [
        { internalId: "AN-1", name: "A" },
        { internalId: "AN-2", name: "B" },
      ],
      contracts: [
        // missing supplier -> dropped
        {
          internalId: "WS-10",
          documentNumber: "C-10",
          effectiveDate: "2026-01-01",
          expirationDate: "2026-12-31",
        } as AribaContract,
      ],
      invoices: [
        // missing supplier -> dropped
        {
          internalId: "INV-20",
          documentNumber: "I-20",
          invoiceDate: "2026-02-01",
        } as AribaInvoice,
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
