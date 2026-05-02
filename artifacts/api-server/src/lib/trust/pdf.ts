/**
 * PDF renderer for the customer-facing Trust Center.
 *
 * Uses pdfkit (already a dependency for the Defense Pack renderer) to
 * produce a paginated PDF directly from the same `TrustSummaryPayload`
 * the in-app `/trust` page consumes — no headless browser needed,
 * keeping the runtime dependency surface and cold-start latency small.
 *
 * Each page footer carries the snapshot timestamp and an
 * `n / total` page counter so the artifact a procurement reviewer
 * attaches to a sourcing ticket is unambiguously dated.
 */

import PDFDocument from "pdfkit";
import type { TrustSummaryPayload } from "./summary";

const MARGIN = 56;
const FOOTER_HEIGHT = 28;

const TIER_BLURB: Record<"T1" | "T2" | "T3" | "T4", string> = {
  T1: "Public, attributable (gov filings, regulator disclosures, official APIs).",
  T2: "Public-API derivative — aggregations of T1 data, sources still attributable.",
  T3: "Quality-scored only — ToS forbids republishing the link.",
  T4: "Model-derived inference; no upstream citation. Tenant policy gated.",
};

function policyBlurb(policy: string): string {
  if (policy === "conservative")
    return "Only T1/T2 sources are surfaced; T3/T4 are silently filtered.";
  if (policy === "analyst")
    return "All tiers shown including T4 inference, with appropriate labelling.";
  return "T1/T2 fully cited; T3 shown with quality score; T4 hidden.";
}

function statusLabel(status: string): string {
  if (status === "in_progress") return "In progress";
  if (status === "not_applicable") return "Not applicable";
  if (status === "attested") return "Attested";
  if (status === "planned") return "Planned";
  return status;
}

function formatTimestamp(value: string | Date | null): string {
  if (value == null) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function formatPercent(p: number): string {
  if (!Number.isFinite(p)) return "—";
  return `${(p * 100).toFixed(1)}%`;
}

/**
 * Render a Trust Center summary to a PDF Buffer.
 *
 * Resolves once the underlying pdfkit stream finishes flushing.
 */
export async function renderTrustSummaryPdf(
  summary: TrustSummaryPayload,
): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: "LETTER",
      margins: {
        top: MARGIN,
        bottom: MARGIN + FOOTER_HEIGHT,
        left: MARGIN,
        right: MARGIN,
      },
      bufferPages: true,
      info: {
        Title: `Trust Center — ${summary.tenant.orgName}`,
        Author: "Procuro",
        Subject: "Tenant trust posture",
        CreationDate: new Date(summary.generatedAt),
      },
    });

    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    drawBody(doc, summary);
    drawFooters(doc, summary);

    doc.end();
  });
}

type PdfDoc = InstanceType<typeof PDFDocument>;

function h1(doc: PdfDoc, text: string): void {
  doc.fontSize(20).font("Helvetica-Bold").fillColor("#000").text(text);
  doc.moveDown(0.4);
}

function h2(doc: PdfDoc, text: string): void {
  doc.moveDown(0.6);
  doc.fontSize(13).font("Helvetica-Bold").fillColor("#111").text(text);
  doc.moveDown(0.3);
}

function p(doc: PdfDoc, text: string, opts?: { color?: string }): void {
  doc.fontSize(10).font("Helvetica").fillColor(opts?.color ?? "#222").text(text, {
    align: "left",
  });
}

function kv(doc: PdfDoc, label: string, value: string): void {
  doc
    .fontSize(9.5)
    .font("Helvetica-Bold")
    .fillColor("#555")
    .text(`${label}: `, { continued: true })
    .font("Helvetica")
    .fillColor("#111")
    .text(value);
}

function drawBody(doc: PdfDoc, s: TrustSummaryPayload): void {
  // Header --------------------------------------------------------------
  h1(doc, "Trust Center");
  doc
    .fontSize(11)
    .font("Helvetica")
    .fillColor("#444")
    .text(
      `Live posture for ${s.tenant.orgName} — assembled from this tenant's runtime state.`,
    );
  doc.moveDown(0.3);
  doc
    .fontSize(9)
    .fillColor("#666")
    .text(`Snapshot generated ${formatTimestamp(s.generatedAt)}`);
  doc.moveDown(0.5);

  // Tenant context ------------------------------------------------------
  h2(doc, "Tenant context");
  kv(doc, "Organization", s.tenant.orgName);
  kv(doc, "Org ID", s.tenant.orgId);
  kv(doc, "Org slug", s.tenant.orgSlug);
  kv(doc, "Active disclosure policy", s.tenant.disclosurePolicy);
  doc.moveDown(0.2);
  p(doc, policyBlurb(s.tenant.disclosurePolicy), { color: "#555" });

  // Data sources --------------------------------------------------------
  h2(doc, "Live data sources");
  const ds = s.dataSources;
  kv(doc, "Enabled", String(ds.enabledCount));
  kv(doc, "Total visible", String(ds.totalCount));
  kv(
    doc,
    "By tier",
    `T1=${ds.byTier.T1}  T2=${ds.byTier.T2}  T3=${ds.byTier.T3}  T4=${ds.byTier.T4}`,
  );
  doc.moveDown(0.3);

  if (ds.collectors.length === 0) {
    p(doc, "No collectors visible to this tenant yet.", { color: "#666" });
  } else {
    drawCollectorTable(doc, ds.collectors);
  }

  // Operational controls ------------------------------------------------
  h2(doc, "Operational controls");
  const oc = s.operationalControls;
  kv(doc, "Killed collectors", String(oc.killSwitch.killedCount));
  if (oc.killSwitch.killedCollectors.length > 0) {
    for (const k of oc.killSwitch.killedCollectors.slice(0, 8)) {
      doc
        .fontSize(9)
        .font("Helvetica")
        .fillColor("#333")
        .text(`  • ${k.name} (${k.id})`);
    }
  }
  doc.moveDown(0.2);
  kv(
    doc,
    "Schema-drift events (30d)",
    String(oc.schemaDrift.recentEventCount),
  );
  if (oc.schemaDrift.recentEvents.length > 0) {
    for (const e of oc.schemaDrift.recentEvents.slice(0, 5)) {
      doc
        .fontSize(9)
        .font("Helvetica")
        .fillColor("#333")
        .text(
          `  • ${e.collectorId} — ${e.message} (${e.occurrences}× · ${formatTimestamp(e.createdAt)})`,
        );
    }
  }
  doc.moveDown(0.2);
  doc
    .fontSize(9.5)
    .font("Helvetica-Bold")
    .fillColor("#555")
    .text("Retry budgets (per job kind):");
  for (const r of oc.retryBudgets) {
    doc
      .fontSize(9)
      .font("Helvetica")
      .fillColor("#333")
      .text(
        `  • ${r.kind}: ${r.maxAttempts}${
          r.isOverride ? ` (default ${r.defaultMaxAttempts})` : ""
        }`,
      );
  }

  // Provenance ----------------------------------------------------------
  h2(doc, "Provenance & citations");
  const pv = s.provenance;
  kv(doc, "Opportunities total", String(pv.opportunitiesTotal));
  kv(doc, "With citations", String(pv.opportunitiesWithCitations));
  kv(doc, "Unverified", String(pv.opportunitiesUnverified));
  kv(doc, "Coverage", formatPercent(pv.coveragePct));
  doc.moveDown(0.2);
  p(
    doc,
    "An opportunity is verified when at least one source descriptor is attached. T3/T4 sources still count for coverage even when the renderer hides them per the tenant's disclosure policy.",
    { color: "#555" },
  );

  // Audit ---------------------------------------------------------------
  h2(doc, "Audit & retention");
  const a = s.audit;
  kv(doc, "Retention", `${a.retentionDays} days`);
  kv(doc, "Events (30d)", String(a.eventCount30d));
  kv(doc, "Last admin event", formatTimestamp(a.lastEventAt));
  kv(doc, "Export formats", a.exportFormats.join(", "));

  // Identity & access ---------------------------------------------------
  h2(doc, "Identity & access");
  const id = s.identity;
  kv(
    doc,
    "SSO",
    id.sso.enabled
      ? `${id.sso.idpName ?? "—"} (${id.sso.protocol?.toUpperCase() ?? "?"})`
      : "Not configured",
  );
  kv(doc, "SCIM provisioning", id.scimEnabled ? "Enabled" : "Disabled");
  if (id.sso.enabled && id.sso.emailDomains.length > 0) {
    kv(doc, "SSO domains", id.sso.emailDomains.join(", "));
  }
  doc.moveDown(0.2);
  doc
    .fontSize(9.5)
    .font("Helvetica-Bold")
    .fillColor("#555")
    .text("Role catalogue:");
  for (const r of id.roles) {
    doc
      .fontSize(9)
      .font("Helvetica")
      .fillColor("#333")
      .text(
        `  • ${r.role}: ${r.permissions.length === 0 ? "—" : r.permissions.join(", ")}`,
      );
  }

  // Compliance ----------------------------------------------------------
  h2(doc, "Compliance posture");
  for (const att of s.compliance.attestations) {
    doc
      .fontSize(10)
      .font("Helvetica-Bold")
      .fillColor("#111")
      .text(`${att.name}  `, { continued: true })
      .font("Helvetica")
      .fillColor("#666")
      .text(`[${statusLabel(att.status)}]`);
    if (att.detail) {
      doc
        .fontSize(9)
        .font("Helvetica")
        .fillColor("#333")
        .text(`  ${att.detail}`);
    }
    if (att.asOf) {
      doc
        .fontSize(8.5)
        .fillColor("#777")
        .text(`  As of ${formatTimestamp(att.asOf)}`);
    }
    doc.moveDown(0.2);
  }
  doc.moveDown(0.2);
  kv(
    doc,
    "DPA",
    s.compliance.dpaUrl ?? "Available on request",
  );
  kv(
    doc,
    "Sub-processors",
    s.compliance.subProcessorsUrl ?? "Available on request",
  );
  kv(doc, "Security contact", s.compliance.securityContact.email);
  if (s.compliance.securityContact.pgpKeyUrl) {
    kv(doc, "Security PGP key", s.compliance.securityContact.pgpKeyUrl);
  }

  // Disclosure-tier explainer ------------------------------------------
  h2(doc, "Disclosure tiers");
  for (const tier of ["T1", "T2", "T3", "T4"] as const) {
    doc
      .fontSize(10)
      .font("Helvetica-Bold")
      .fillColor("#111")
      .text(`${tier}  `, { continued: true })
      .font("Helvetica")
      .fillColor("#333")
      .text(TIER_BLURB[tier]);
  }
}

function drawCollectorTable(
  doc: PdfDoc,
  collectors: TrustSummaryPayload["dataSources"]["collectors"],
): void {
  const startX = doc.page.margins.left;
  const usableWidth =
    doc.page.width - doc.page.margins.left - doc.page.margins.right;
  // 6 columns: Source | Tier | Posture | Jurisdiction | Retention | Status
  const cols = [
    { label: "Source", width: usableWidth * 0.32 },
    { label: "Tier", width: usableWidth * 0.08 },
    { label: "Posture", width: usableWidth * 0.22 },
    { label: "Jurisdiction", width: usableWidth * 0.13 },
    { label: "Retention", width: usableWidth * 0.1 },
    { label: "Status", width: usableWidth * 0.15 },
  ];
  const rowPadding = 4;

  const drawHeader = () => {
    let x = startX;
    const y = doc.y;
    doc.fontSize(8.5).font("Helvetica-Bold").fillColor("#444");
    for (const c of cols) {
      doc.text(c.label, x + 2, y, { width: c.width - 4 });
      x += c.width;
    }
    doc.moveDown(0.4);
    const lineY = doc.y;
    doc
      .strokeColor("#ccc")
      .lineWidth(0.5)
      .moveTo(startX, lineY)
      .lineTo(startX + usableWidth, lineY)
      .stroke();
    doc.moveDown(0.2);
  };

  drawHeader();

  for (const c of collectors) {
    const cells = [
      c.name,
      c.disclosureTier,
      c.postureClass,
      c.jurisdiction || "—",
      c.retentionDays != null ? `${c.retentionDays} d` : "—",
      c.status,
    ];

    // Compute row height = max of per-cell heights
    doc.fontSize(8.5).font("Helvetica");
    const heights = cells.map((text, i) =>
      doc.heightOfString(String(text), {
        width: cols[i]!.width - 4,
      }),
    );
    const rowHeight = Math.max(...heights) + rowPadding;

    // Page break if needed (account for footer reservation).
    const bottomLimit = doc.page.height - doc.page.margins.bottom;
    if (doc.y + rowHeight > bottomLimit) {
      doc.addPage();
      drawHeader();
    }

    const y = doc.y;
    let x = startX;
    doc.fillColor("#222");
    cells.forEach((text, i) => {
      doc.text(String(text), x + 2, y, {
        width: cols[i]!.width - 4,
      });
      x += cols[i]!.width;
    });
    doc.y = y + rowHeight;
  }
}

/**
 * Footer with snapshot timestamp + page counter, drawn after the body
 * content is laid out so we know `bufferedPageRange` covers every page.
 */
function drawFooters(doc: PdfDoc, s: TrustSummaryPayload): void {
  const range = doc.bufferedPageRange();
  const total = range.count;
  const ts = formatTimestamp(s.generatedAt);

  for (let i = 0; i < total; i += 1) {
    const pageNum = range.start + i;
    doc.switchToPage(pageNum);
    const y = doc.page.height - MARGIN - FOOTER_HEIGHT + 8;
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    doc
      .strokeColor("#e0e0e0")
      .lineWidth(0.5)
      .moveTo(left, y - 6)
      .lineTo(right, y - 6)
      .stroke();
    doc
      .fontSize(8)
      .font("Helvetica")
      .fillColor("#666")
      .text(
        `Procuro Trust Center — ${s.tenant.orgName} — snapshot ${ts}`,
        left,
        y,
        { width: (right - left) * 0.75, lineBreak: false },
      );
    doc.text(
      `Page ${i + 1} of ${total}`,
      left,
      y,
      {
        width: right - left,
        align: "right",
        lineBreak: false,
      },
    );
  }
}
