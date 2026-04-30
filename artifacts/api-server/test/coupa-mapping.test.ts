/**
 * Unit tests for the Coupa → IngestPayload mapping. Pure functions, no
 * I/O — pinning the field-by-field transformation against captured
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
  mapSupplier,
  type CoupaContract,
  type CoupaInvoice,
  type CoupaPayment,
  type CoupaPurchaseOrder,
  type CoupaSupplier,
} from "../src/lib/connectors/coupa/mapping";

describe("coupa mapping", () => {
  it("maps a supplier with optional fields preserved", () => {
    const wire: CoupaSupplier = {
      id: 7421,
      name: "  Acme Components  ",
      countryCode: "US",
      currencyCode: "USD",
      paymentTerms: { code: "N30", netDays: 30 },
      preferred: true,
      tags: ["strategic", "tier-1"],
      updatedAt: "2026-04-01T10:00:00Z",
    };
    const out = mapSupplier(wire);
    assert.equal(out.externalId, "7421");
    assert.equal(out.name, "  Acme Components  ");
    assert.equal(out.countryCode, "US");
    assert.equal(out.billingCurrency, "USD");
    assert.equal(out.paymentTermsDays, "30");
    assert.equal(out.isPreferred, true);
    assert.deepEqual(out.tags, ["strategic", "tier-1"]);
  });

  it("supplier mapper tolerates missing optionals and defaults flags", () => {
    const out = mapSupplier({ id: 1, name: "Bare" });
    assert.equal(out.externalId, "1");
    assert.equal(out.isPreferred, false);
    assert.equal(out.isStrategic, false);
    assert.deepEqual(out.tags, []);
    assert.equal(out.countryCode, undefined);
  });

  it("contract mapper drops contracts without a supplier or dates", () => {
    const ok: CoupaContract = {
      id: 100,
      number: "C-100",
      name: "Master Services",
      supplierId: 7421,
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      paymentTerms: { netDays: 45 },
      totalValue: { value: "250000.50", currencyCode: "USD" },
      updatedAt: "2026-04-01T10:00:00Z",
    };
    const okMapped = mapContract(ok);
    assert.ok(okMapped);
    assert.equal(okMapped!.supplierExternalId, "7421");
    assert.equal(okMapped!.paymentTermsDays, 45);
    assert.equal(okMapped!.annualBaselineUsd, 250000.5);

    assert.equal(
      mapContract({ ...ok, supplierId: null }),
      null,
      "missing supplier -> drop",
    );
    assert.equal(
      mapContract({ ...ok, startDate: null }),
      null,
      "missing startDate -> drop",
    );
  });

  it("PO mapper carries lines, infers spend class from commodity name", () => {
    const wire: CoupaPurchaseOrder = {
      id: 555,
      poNumber: "PO-555",
      supplierId: 7421,
      contractId: 100,
      orderDate: "2026-04-15T00:00:00Z",
      total: { value: "2500", currencyCode: "USD" },
      lines: [
        {
          id: 5551,
          lineNumber: 1,
          description: "Steel sheet",
          itemNumber: "STL-001",
          quantity: 10,
          uom: "EA",
          price: { value: "100", currencyCode: "USD" },
          commodity: { name: "Raw Steel" },
        },
        {
          id: 5552,
          lineNumber: 2,
          description: "Consulting hours",
          itemNumber: "SVC-002",
          quantity: 15,
          price: { value: "100", currencyCode: "USD" },
          commodity: { name: "Strategy Consulting" },
        },
      ],
      updatedAt: "2026-04-15T01:00:00Z",
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
    const base: CoupaInvoice = {
      id: 9001,
      invoiceNumber: "INV-9001",
      supplierId: 7421,
      poId: 555,
      invoiceDate: "2026-04-20",
      total: { value: "1000", currencyCode: "USD" },
      status: "approved_for_payment",
    };
    const out = mapInvoice(base);
    assert.ok(out);
    assert.equal(out!.status, "approved");
    assert.equal(out!.dedupKey, "coupa:9001:INV-9001");

    assert.equal(mapInvoice({ ...base, status: "voided" })!.status, "void");
    assert.equal(
      mapInvoice({ ...base, status: "draft" })!.status,
      "received",
    );
  });

  it("payment mapper preserves invoice link and amount", () => {
    const wire: CoupaPayment = {
      id: 70001,
      invoiceId: 9001,
      paidDate: "2026-05-15T00:00:00Z",
      total: { value: "1000", currencyCode: "USD" },
      paymentTerms: { netDays: 25 },
    };
    const out = mapPayment(wire);
    assert.ok(out);
    assert.equal(out!.invoiceExternalId, "9001");
    assert.equal(out!.amountUsd, 1000);
    assert.equal(out!.paymentTermsDays, 25);
  });

  it("buildIngestPayload reports per-entity drop counts", () => {
    const { payload, dropped } = buildIngestPayload({
      suppliers: [
        { id: 1, name: "A" },
        { id: 2, name: "B" },
      ],
      contracts: [
        // missing supplier -> dropped
        {
          id: 10,
          number: "C-10",
          startDate: "2026-01-01",
          endDate: "2026-12-31",
        } as CoupaContract,
      ],
      invoices: [
        // missing supplierId -> dropped
        { id: 20, invoiceNumber: "I-20", invoiceDate: "2026-02-01" } as CoupaInvoice,
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
