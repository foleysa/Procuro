/**
 * Thin xlsx parsing helper backed by ExcelJS (replaces node-xlsx / SheetJS
 * community-edition which has unpatched high-severity CVEs).
 *
 * API surface mirrors the subset of node-xlsx that the collectors use:
 *   parseXlsxBuffer(buf) → Promise<Array<{name: string; data: Row[]}>>
 * where `Row` is an array of raw cell values (string | number | boolean |
 * Date | null | undefined), matching the shape returned by node-xlsx.parse().
 */

import ExcelJS from "exceljs";

export type XlsxCell = string | number | boolean | Date | null | undefined;
export type XlsxRow = XlsxCell[];
export interface XlsxSheet {
  name: string;
  data: XlsxRow[];
}

function normalizeCellValue(v: ExcelJS.CellValue): XlsxCell {
  if (v === null || v === undefined) return null;
  if (
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "boolean"
  ) {
    return v;
  }
  if (v instanceof Date) return v;
  if (typeof v === "object") {
    if ("richText" in v) {
      return (v as ExcelJS.CellRichTextValue).richText
        .map((r) => r.text)
        .join("");
    }
    if ("formula" in v) {
      const fv = v as ExcelJS.CellFormulaValue;
      return normalizeCellValue(
        fv.result as ExcelJS.CellValue,
      );
    }
    if ("hyperlink" in v) {
      return (v as ExcelJS.CellHyperlinkValue).text ?? null;
    }
    if ("error" in v) return null;
  }
  return null;
}

/**
 * Parse an xlsx/xls buffer and return an array of sheets. Each sheet has a
 * `name` string and a `data` array-of-arrays of raw cell values, with empty
 * rows represented as empty arrays and sparse rows having `undefined` at
 * positions before the first populated cell.
 */
export async function parseXlsxBuffer(buf: Buffer): Promise<XlsxSheet[]> {
  const workbook = new ExcelJS.Workbook();
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  await workbook.xlsx.load(ab as ArrayBuffer);
  return workbook.worksheets.map((ws) => {
    const data: XlsxRow[] = [];
    ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      const cells: XlsxRow = [];
      const vals = row.values as (ExcelJS.CellValue | null | undefined)[];
      for (let i = 1; i < vals.length; i++) {
        cells.push(normalizeCellValue(vals[i] as ExcelJS.CellValue));
      }
      data[rowNumber - 1] = cells;
    });
    return { name: ws.name, data };
  });
}
