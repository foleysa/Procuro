/**
 * PDF renderer for Defense Packs.
 *
 * pdfkit (pure JS, no headless browser) → in-memory Buffer.
 *
 * The renderer reads the persisted `defense_packs` row directly so the
 * Evidence Room view and the PDF always show the same numbers — both
 * pull from the same `evidenceSnapshot` and `sections` JSONB.
 */

import PDFDocument from "pdfkit";
import type { DefensePackRow } from "@workspace/db";

const MARGIN = 56;

function formatPositionLabel(position: string): string {
  return (
    {
      defend_against_increase: "Defend against price increase",
      attack_for_decrease: "Attack for price decrease",
      justify_index_relink: "Justify index relink",
    }[position] ?? position
  );
}

/**
 * Render a Defense Pack to a PDF Buffer. Resolves once the underlying
 * pdfkit stream finishes flushing.
 */
export async function renderDefensePackPdf(
  pack: DefensePackRow,
): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: "LETTER",
      margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
      info: {
        Title: `Defense Pack: ${pack.target.supplierName}`,
        Author: pack.generatedBy,
        Subject: formatPositionLabel(pack.position),
        CreationDate: pack.generatedAt ?? pack.createdAt,
      },
    });

    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // -- Header -------------------------------------------------------
    doc.fontSize(18).font("Helvetica-Bold").text("Defense Pack", { align: "left" });
    doc.moveDown(0.25);
    doc
      .fontSize(11)
      .font("Helvetica")
      .fillColor("#444")
      .text(
        `${formatPositionLabel(pack.position)} — ${pack.target.supplierName}`,
      );
    if (pack.target.lineItem) {
      doc.text(`Contract line: ${pack.target.lineItem}`);
    }
    if (pack.target.materialCode) {
      doc.text(`Material: ${pack.target.materialCode}`);
    }
    if (pack.target.categoryCode) {
      doc.text(`Category: ${pack.target.categoryCode}`);
    }
    doc.moveDown(0.5);
    doc
      .fontSize(9)
      .fillColor("#888")
      .text(
        `Generated ${(pack.generatedAt ?? pack.createdAt).toISOString()} by ${pack.generatedBy}`,
      );
    doc.text(`Pack ID ${pack.id} · model ${pack.model ?? "n/a"}`);
    doc.moveDown(1);
    doc.fillColor("#000");

    // -- Sections -----------------------------------------------------
    for (const section of pack.sections) {
      doc.fontSize(13).font("Helvetica-Bold").text(section.title);
      doc.moveDown(0.25);
      doc
        .fontSize(10.5)
        .font("Helvetica")
        .text(section.narrative, { align: "left" });
      if (section.claims.length > 0) {
        doc.moveDown(0.5);
        doc.fontSize(10).font("Helvetica-Bold").text("Citations");
        doc.font("Helvetica").fontSize(9.5);
        for (const claim of section.claims) {
          const evidence = pack.evidenceSnapshot.find(
            (s) => s.signalId === claim.signalId,
          );
          const sourceBits = evidence
            ? `${evidence.collectorName} · ${evidence.signalType} · ${evidence.observedAt.slice(0, 10)} · ${evidence.tier}`
            : `signal ${claim.signalId}`;
          doc.text(`• ${claim.text}`, { indent: 12 });
          doc
            .fillColor("#555")
            .text(`   ${claim.valueQuoted}  —  ${sourceBits}`, { indent: 12 });
          if (evidence?.sourceUrl) {
            doc
              .fillColor("#1a4fb4")
              .text(`   ${evidence.sourceUrl}`, {
                indent: 12,
                link: evidence.sourceUrl,
                underline: true,
              });
          }
          doc.fillColor("#000");
        }
      }
      doc.moveDown(0.75);
    }

    // -- Footer / Evidence Room note ----------------------------------
    doc
      .fontSize(8.5)
      .fillColor("#666")
      .text(
        `This memo's evidence pool is frozen at generation time. Live values may have changed; the Evidence Room view at /defense-packs/${pack.id} replays the snapshot exactly as cited above.`,
        { align: "left" },
      );

    doc.end();
  });
}
