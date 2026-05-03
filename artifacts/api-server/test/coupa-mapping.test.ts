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
  mapRateCard,
  mapStatementOfWork,
  mapSupplier,
  mapTimeEntry,
  type CoupaContract,
  type CoupaInvoice,
  type CoupaPayment,
  type CoupaPurchaseOrder,
  type CoupaRateCard,
  type CoupaStatementOfWork,
  type CoupaSupplier,
  type CoupaTimeEntry,
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
    // Task #232 — categoryCodeFromCommodity wired into PO line mapping
    // so the writer can resolve a category row by external code.
    // "Raw Steel" doesn't match any conservative rule → omitted.
    assert.equal(mapped!.lines[0]!.categoryExternalId, undefined);
    // "Strategy Consulting" → PROF_CONSULTING_STRATEGY.
    assert.equal(
      mapped!.lines[1]!.categoryExternalId,
      "PROF_CONSULTING_STRATEGY",
    );
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

  it("contract mapper forwards parentContractId as msaParentExternalId", () => {
    const child: CoupaContract = {
      id: 200,
      number: "SOW-200",
      supplierId: 7421,
      parentContractId: 100,
      startDate: "2026-02-01",
      endDate: "2026-11-30",
    };
    const mapped = mapContract(child);
    assert.ok(mapped);
    assert.equal(mapped!.msaParentExternalId, "100");

    const standalone = mapContract({ ...child, parentContractId: null });
    assert.ok(standalone);
    assert.equal(standalone!.msaParentExternalId, undefined);
  });

  it("SOW mapper attaches to parent contract and emits milestones/change orders", () => {
    const wire: CoupaStatementOfWork = {
      id: 501,
      number: "SOW-501",
      name: "Q2 Implementation",
      contractId: 100,
      supplierId: 7421,
      status: "in_progress",
      startDate: "2026-04-01",
      endDate: "2026-09-30",
      totalValue: { value: "120000", currencyCode: "USD" },
      acceptanceCriteria: "All milestones signed off by sponsor",
      milestones: [
        {
          id: 9001,
          number: 1,
          name: "Discovery",
          dueDate: "2026-05-01",
          value: { value: "30000", currencyCode: "USD" },
          status: "delivered",
          deliveredAt: "2026-05-02",
        },
        {
          number: 2,
          name: "Build",
          dueDate: "2026-07-15",
          status: "in_progress",
        },
      ],
      changeOrders: [
        {
          id: 8001,
          number: "CO-1",
          name: "Add training",
          status: "approved",
          valueDelta: { value: "10000", currencyCode: "USD" },
          dateDeltaDays: 14,
        },
      ],
    };
    const out = mapStatementOfWork(wire);
    assert.ok(out);
    assert.equal(out!.externalId, "501");
    assert.equal(out!.contractExternalId, "100");
    assert.equal(out!.supplierExternalId, "7421");
    assert.equal(out!.status, "active");
    assert.equal(out!.totalValueUsd, 120000);
    assert.equal(out!.milestones?.length, 2);
    assert.equal(out!.milestones![0]!.status, "delivered");
    assert.equal(out!.milestones![0]!.valueUsd, 30000);
    assert.equal(out!.changeOrders?.length, 1);
    assert.equal(out!.changeOrders![0]!.status, "approved");
    assert.equal(out!.changeOrders![0]!.valueDeltaUsd, 10000);
  });

  it("SOW mapper drops rows missing supplier, parent contract, or dates", () => {
    const base: CoupaStatementOfWork = {
      id: 600,
      number: "SOW-600",
      contractId: 100,
      supplierId: 7421,
      startDate: "2026-04-01",
      endDate: "2026-09-30",
    };
    assert.ok(mapStatementOfWork(base));
    assert.equal(mapStatementOfWork({ ...base, contractId: null }), null);
    assert.equal(mapStatementOfWork({ ...base, supplierId: null }), null);
    assert.equal(mapStatementOfWork({ ...base, startDate: null }), null);
  });

  it("rate card mapper requires supplier + contract/sow link and carries lines", () => {
    const wire: CoupaRateCard = {
      id: 7001,
      name: "FY26 Consulting Rates",
      supplierId: 7421,
      sowId: 501,
      currencyCode: "USD",
      effectiveDate: "2026-04-01",
      expiryDate: "2027-03-31",
      lines: [
        { role: "Senior Engineer", seniority: "Senior", hourlyRate: "275" },
        { role: "Architect", hourlyRate: "350", roleCode: "ARCH-1" },
      ],
    };
    const out = mapRateCard(wire);
    assert.ok(out);
    assert.equal(out!.sowExternalId, "501");
    assert.equal(out!.lines?.length, 2);
    assert.equal(out!.lines![0]!.hourlyRate, 275);

    // Orphan rate cards (no sow + no contract) are dropped.
    assert.equal(
      mapRateCard({ ...wire, sowId: null, contractId: null }),
      null,
    );
    assert.equal(mapRateCard({ ...wire, supplierId: null }), null);
  });

  it("time entry mapper requires supplier, work date, and finite hours", () => {
    const wire: CoupaTimeEntry = {
      id: 9101,
      supplierId: 7421,
      sowId: 501,
      rateCardId: 7001,
      resource: "Jane Consultant",
      role: "Senior Engineer",
      workDate: "2026-04-15",
      hours: "8",
      billRate: { value: "275", currencyCode: "USD" },
      amount: { value: "2200", currencyCode: "USD" },
    };
    const out = mapTimeEntry(wire);
    assert.ok(out);
    assert.equal(out!.hours, 8);
    assert.equal(out!.billRateUsd, 275);
    assert.equal(out!.amountUsd, 2200);
    assert.equal(out!.sowExternalId, "501");
    assert.equal(out!.rateCardExternalId, "7001");

    assert.equal(mapTimeEntry({ ...wire, supplierId: null }), null);
    assert.equal(mapTimeEntry({ ...wire, workDate: null }), null);
    assert.equal(mapTimeEntry({ ...wire, hours: null }), null);
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
