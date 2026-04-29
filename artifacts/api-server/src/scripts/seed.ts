import { db, orgsTable, agentsTable, outcomeClaimsTable, claimEventsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { newId } from "../lib/ids";

type AgentSeed = {
  id: string;
  name: string;
  role: string;
  kpiDefinition: string;
  status: "active" | "paused" | "retired";
  ratePerOutcomeUsd: number;
};

type ClaimSeed = {
  agentId: string;
  claimType: string;
  title: string;
  description?: string;
  evidenceUrl?: string;
  evidenceLabel?: string;
  estimatedValueUsd: number;
  status: "claimed" | "verified" | "denied" | "invoiced";
  daysAgo: number;
  denialReason?: string;
};

async function seedOrg(opts: {
  id: string;
  name: string;
  slug: string;
  agents: AgentSeed[];
  claims: ClaimSeed[];
}) {
  const existing = await db
    .select({ id: orgsTable.id })
    .from(orgsTable)
    .where(eq(orgsTable.id, opts.id))
    .limit(1);

  if (existing.length === 0) {
    await db.insert(orgsTable).values({
      id: opts.id,
      name: opts.name,
      slug: opts.slug,
    });
    console.log(`✓ Created org ${opts.name}`);
  } else {
    console.log(`~ Org ${opts.name} already exists, skipping insert`);
  }

  for (const a of opts.agents) {
    const present = await db
      .select({ id: agentsTable.id })
      .from(agentsTable)
      .where(eq(agentsTable.id, a.id))
      .limit(1);
    if (present.length > 0) continue;
    await db.insert(agentsTable).values({
      id: a.id,
      orgId: opts.id,
      name: a.name,
      role: a.role,
      kpiDefinition: a.kpiDefinition,
      status: a.status,
      ratePerOutcomeUsd: String(a.ratePerOutcomeUsd),
    });
  }
  console.log(`✓ Seeded ${opts.agents.length} agents for ${opts.name}`);

  // Only seed claims if there are no claims yet for this org
  const existingClaims = await db
    .select({ id: outcomeClaimsTable.id })
    .from(outcomeClaimsTable)
    .where(eq(outcomeClaimsTable.orgId, opts.id))
    .limit(1);

  if (existingClaims.length > 0) {
    console.log(`~ Org ${opts.name} already has claims; skipping claim seed`);
    return;
  }

  for (const c of opts.claims) {
    const claimedAt = new Date();
    claimedAt.setDate(claimedAt.getDate() - c.daysAgo);
    claimedAt.setHours(9 + Math.floor(Math.random() * 8), Math.floor(Math.random() * 60), 0, 0);

    const claimId = newId("clm");
    const verifiedAt =
      c.status === "verified" || c.status === "invoiced" || c.status === "denied"
        ? new Date(claimedAt.getTime() + 1000 * 60 * 60 * (4 + Math.random() * 30))
        : null;

    const agentName = opts.agents.find((a) => a.id === c.agentId)?.name ?? "agent";

    await db.insert(outcomeClaimsTable).values({
      id: claimId,
      orgId: opts.id,
      agentId: c.agentId,
      claimType: c.claimType,
      title: c.title,
      description: c.description ?? null,
      evidenceUrl: c.evidenceUrl ?? null,
      evidenceLabel: c.evidenceLabel ?? null,
      estimatedValueUsd: String(c.estimatedValueUsd),
      status: c.status,
      verifiedBy: c.status === "claimed" ? null : "admin",
      verifiedAt,
      denialReason: c.denialReason ?? null,
      claimedAt,
    });

    // events
    await db.insert(claimEventsTable).values({
      id: newId("evt"),
      claimId,
      orgId: opts.id,
      eventType: "claimed",
      actor: agentName,
      reason: null,
      createdAt: claimedAt,
    });
    if (c.status !== "claimed" && verifiedAt) {
      await db.insert(claimEventsTable).values({
        id: newId("evt"),
        claimId,
        orgId: opts.id,
        eventType: c.status === "denied" ? "denied" : "verified",
        actor: "admin",
        reason: c.denialReason ?? null,
        createdAt: verifiedAt,
      });
      if (c.status === "invoiced") {
        const invoicedAt = new Date(verifiedAt.getTime() + 1000 * 60 * 60 * 24);
        await db.insert(claimEventsTable).values({
          id: newId("evt"),
          claimId,
          orgId: opts.id,
          eventType: "invoiced",
          actor: "billing-system",
          reason: null,
          createdAt: invoicedAt,
        });
      }
    }
  }
  console.log(`✓ Seeded ${opts.claims.length} claims for ${opts.name}`);
}

async function main() {
  // SCIS — primary demo org, rich data
  const scisAgents: AgentSeed[] = [
    {
      id: "agt_scis_exception_resolver",
      name: "exception_resolver",
      role: "Resolves stuck purchase order exceptions in the procurement queue without human escalation.",
      kpiDefinition: "PO exception cleared end-to-end with valid supporting evidence and no downstream rework.",
      status: "active",
      ratePerOutcomeUsd: 18.5,
    },
    {
      id: "agt_scis_contract_negotiator",
      name: "contract_negotiator",
      role: "Negotiates renewal terms on indirect-spend supplier contracts under $250k ACV.",
      kpiDefinition: "Signed renewal at ≥3% lower unit price than prior term, retained by supplier.",
      status: "active",
      ratePerOutcomeUsd: 425.0,
    },
    {
      id: "agt_scis_supplier_onboarder",
      name: "supplier_onboarder",
      role: "Runs supplier onboarding from intake form through tax/banking validation to ERP record.",
      kpiDefinition: "Supplier reaches 'ready-to-transact' status in ERP with passing compliance checks.",
      status: "active",
      ratePerOutcomeUsd: 75.0,
    },
    {
      id: "agt_scis_invoice_triage",
      name: "invoice_triage",
      role: "Pre-scrubs incoming AP invoices for PO match, GL coding, and duplicate detection.",
      kpiDefinition: "Invoice routed to correct approver with zero downstream coding corrections.",
      status: "paused",
      ratePerOutcomeUsd: 4.25,
    },
  ];

  const t = (claimType: string, title: string, value: number, agent: string, status: ClaimSeed["status"], daysAgo: number, opts: Partial<ClaimSeed> = {}): ClaimSeed => ({
    claimType,
    title,
    estimatedValueUsd: value,
    agentId: agent,
    status,
    daysAgo,
    ...opts,
  });

  const scisClaims: ClaimSeed[] = [
    t("po_exception_resolved", "PO #44218 — supplier short-shipped, credit memo issued", 1280, "agt_scis_exception_resolver", "verified", 1, { evidenceUrl: "https://example.com/audit/44218", evidenceLabel: "ERP audit trail #44218", description: "Carrier delivered 88 of 100 units. Triggered credit memo and updated receipt." }),
    t("po_exception_resolved", "PO #44231 — wrong GL account, recoded to 6420", 540, "agt_scis_exception_resolver", "verified", 1, { evidenceUrl: "https://example.com/audit/44231", evidenceLabel: "ERP audit trail #44231" }),
    t("po_exception_resolved", "PO #44256 — duplicate receipt voided", 2200, "agt_scis_exception_resolver", "claimed", 0, { evidenceUrl: "https://example.com/audit/44256", evidenceLabel: "ERP audit trail #44256", description: "Detected duplicate goods-receipt entered by warehouse staff. Voided dupe, kept original." }),
    t("po_exception_resolved", "PO #44199 — tax mismatch, recalculated VAT", 410, "agt_scis_exception_resolver", "verified", 2, { evidenceUrl: "https://example.com/audit/44199", evidenceLabel: "ERP audit trail #44199" }),
    t("po_exception_resolved", "PO #44280 — vendor bank change validation", 0, "agt_scis_exception_resolver", "denied", 2, { evidenceUrl: "https://example.com/audit/44280", evidenceLabel: "ERP audit trail #44280", denialReason: "No callback verification on file with treasury — must follow new bank-change SOP before crediting outcome." }),
    t("po_exception_resolved", "PO #44301 — partial receipt reconciled", 760, "agt_scis_exception_resolver", "verified", 3, { evidenceUrl: "https://example.com/audit/44301", evidenceLabel: "ERP audit trail #44301" }),
    t("po_exception_resolved", "PO #44322 — freight charge mismatch resolved", 285, "agt_scis_exception_resolver", "verified", 3, { evidenceUrl: "https://example.com/audit/44322", evidenceLabel: "ERP audit trail #44322" }),
    t("po_exception_resolved", "PO #44340 — line-item missing UoM", 130, "agt_scis_exception_resolver", "claimed", 0, { evidenceUrl: "https://example.com/audit/44340", evidenceLabel: "ERP audit trail #44340" }),
    t("po_exception_resolved", "PO #44175 — supplier early-pay discount captured", 1640, "agt_scis_exception_resolver", "invoiced", 8, { evidenceUrl: "https://example.com/audit/44175", evidenceLabel: "ERP audit trail #44175" }),
    t("po_exception_resolved", "PO #44188 — currency conversion correction", 720, "agt_scis_exception_resolver", "invoiced", 9, { evidenceUrl: "https://example.com/audit/44188", evidenceLabel: "ERP audit trail #44188" }),
    t("po_exception_resolved", "PO #44150 — receipt date backdated within window", 95, "agt_scis_exception_resolver", "verified", 12, { evidenceUrl: "https://example.com/audit/44150", evidenceLabel: "ERP audit trail #44150" }),
    t("po_exception_resolved", "PO #44120 — three-way match restored", 3400, "agt_scis_exception_resolver", "invoiced", 16, { evidenceUrl: "https://example.com/audit/44120", evidenceLabel: "ERP audit trail #44120" }),
    t("po_exception_resolved", "PO #44102 — split shipment unified", 880, "agt_scis_exception_resolver", "verified", 19, { evidenceUrl: "https://example.com/audit/44102", evidenceLabel: "ERP audit trail #44102" }),
    t("po_exception_resolved", "PO #44087 — held line released after compliance check", 540, "agt_scis_exception_resolver", "invoiced", 22, { evidenceUrl: "https://example.com/audit/44087", evidenceLabel: "ERP audit trail #44087" }),
    t("po_exception_resolved", "PO #44070 — voided erroneously, reissued", 1240, "agt_scis_exception_resolver", "verified", 25, { evidenceUrl: "https://example.com/audit/44070", evidenceLabel: "ERP audit trail #44070" }),

    t("contract_renewal_savings", "Acme Widgets renewal — 4.1% unit price reduction, 24mo term", 22400, "agt_scis_contract_negotiator", "verified", 4, { evidenceUrl: "https://example.com/contracts/acme-2026", evidenceLabel: "Acme renewal — DocuSign envelope", description: "Renewed annual spend $546k at $524k. Supplier accepted volume rebate in exchange for term extension." }),
    t("contract_renewal_savings", "Northwind Logistics — 3.5% reduction on hub fees", 14800, "agt_scis_contract_negotiator", "invoiced", 11, { evidenceUrl: "https://example.com/contracts/northwind-2026", evidenceLabel: "Northwind renewal — DocuSign envelope" }),
    t("contract_renewal_savings", "BlueRiver IT supplies — declined; supplier walked", 0, "agt_scis_contract_negotiator", "denied", 6, { denialReason: "Counterparty did not sign within negotiation window. No realized savings — outcome cannot be claimed under current contract." }),
    t("contract_renewal_savings", "Helios Office — 5.2% reduction on managed print", 9600, "agt_scis_contract_negotiator", "claimed", 0, { evidenceUrl: "https://example.com/contracts/helios-2026", evidenceLabel: "Helios renewal — DocuSign envelope", description: "Awaiting Finance signoff on new SLA terms before formal verification." }),
    t("contract_renewal_savings", "Vega Cleaning Services — 3.0% reduction", 4200, "agt_scis_contract_negotiator", "verified", 14, { evidenceUrl: "https://example.com/contracts/vega-2026", evidenceLabel: "Vega renewal — DocuSign envelope" }),
    t("contract_renewal_savings", "Polaris Maintenance — 6.2% reduction", 18800, "agt_scis_contract_negotiator", "invoiced", 21, { evidenceUrl: "https://example.com/contracts/polaris-2026", evidenceLabel: "Polaris renewal — DocuSign envelope" }),

    t("supplier_onboarded", "Onboarded Tessera Components — Tier 2 supplier, ready-to-transact", 75, "agt_scis_supplier_onboarder", "verified", 5, { evidenceUrl: "https://example.com/erp/suppliers/tessera", evidenceLabel: "ERP supplier record — Tessera" }),
    t("supplier_onboarded", "Onboarded Magnolia Packaging — passed sanctions screen", 75, "agt_scis_supplier_onboarder", "verified", 7, { evidenceUrl: "https://example.com/erp/suppliers/magnolia", evidenceLabel: "ERP supplier record — Magnolia" }),
    t("supplier_onboarded", "Onboarded Ironbridge Steel — W-9 + COI on file", 75, "agt_scis_supplier_onboarder", "invoiced", 12, { evidenceUrl: "https://example.com/erp/suppliers/ironbridge", evidenceLabel: "ERP supplier record — Ironbridge" }),
    t("supplier_onboarded", "Onboarded Quill Stationery — ready in 36h", 75, "agt_scis_supplier_onboarder", "verified", 9, { evidenceUrl: "https://example.com/erp/suppliers/quill", evidenceLabel: "ERP supplier record — Quill" }),
    t("supplier_onboarded", "Onboarded Ridgemark Logistics — held, address mismatch", 0, "agt_scis_supplier_onboarder", "denied", 18, { denialReason: "Bank-account holder name does not match registered legal entity. Supplier returned to manual queue per policy." }),
    t("supplier_onboarded", "Onboarded Verdigris Cleaning Co. — ready-to-transact", 75, "agt_scis_supplier_onboarder", "claimed", 0, { evidenceUrl: "https://example.com/erp/suppliers/verdigris", evidenceLabel: "ERP supplier record — Verdigris" }),
    t("supplier_onboarded", "Onboarded Cobalt Industrial Supply — invoiced", 75, "agt_scis_supplier_onboarder", "invoiced", 26, { evidenceUrl: "https://example.com/erp/suppliers/cobalt", evidenceLabel: "ERP supplier record — Cobalt" }),

    t("invoice_pre_scrubbed", "Pre-scrubbed batch INV-2026-04-30 — 412 invoices auto-coded", 1750, "agt_scis_invoice_triage", "verified", 28, { evidenceUrl: "https://example.com/ap/batch/2026-04-30", evidenceLabel: "AP batch summary 2026-04-30" }),
    t("invoice_pre_scrubbed", "Pre-scrubbed batch INV-2026-04-15 — 387 invoices", 1650, "agt_scis_invoice_triage", "invoiced", 14, { evidenceUrl: "https://example.com/ap/batch/2026-04-15", evidenceLabel: "AP batch summary 2026-04-15" }),
  ];

  await seedOrg({
    id: "org_scis",
    name: "SCIS Procurement Services",
    slug: "scis",
    agents: scisAgents,
    claims: scisClaims,
  });

  // Second org — to make the org-switcher meaningful
  const pwAgents: AgentSeed[] = [
    {
      id: "agt_pw_invoice_matcher",
      name: "invoice_matcher",
      role: "Matches inbound supplier invoices to receipts and POs in the AP queue.",
      kpiDefinition: "Three-way match closed cleanly with no human review required.",
      status: "active",
      ratePerOutcomeUsd: 2.75,
    },
    {
      id: "agt_pw_punchout_resolver",
      name: "punchout_resolver",
      role: "Resolves catalog punchout failures in the requisition system.",
      kpiDefinition: "Punchout session recovers and requisition submits within SLA.",
      status: "active",
      ratePerOutcomeUsd: 6.0,
    },
  ];

  const pwClaims: ClaimSeed[] = [
    t("invoice_matched", "Matched INV-90211 to PO #11023", 18, "agt_pw_invoice_matcher", "verified", 1),
    t("invoice_matched", "Matched INV-90244 to PO #11048", 22, "agt_pw_invoice_matcher", "verified", 2),
    t("invoice_matched", "Matched INV-90260 — 0.2% tax variance accepted", 14, "agt_pw_invoice_matcher", "claimed", 0),
    t("punchout_recovered", "Staples punchout session recovered after gateway timeout", 6, "agt_pw_punchout_resolver", "verified", 3),
    t("punchout_recovered", "Grainger punchout session recovered, requisition submitted", 6, "agt_pw_punchout_resolver", "invoiced", 11),
  ];

  await seedOrg({
    id: "org_procureworks",
    name: "ProcureWorks Inc.",
    slug: "procureworks",
    agents: pwAgents,
    claims: pwClaims,
  });

  console.log("\n✓ Seed complete.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
