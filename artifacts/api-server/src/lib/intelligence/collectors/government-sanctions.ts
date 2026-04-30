/**
 * Government sanctions collector — combined OFAC + EU + UK + UN feeds.
 *
 * Pulls four official consolidated lists in their published formats and
 * normalises them into one `sanctions_match` MarketSignal stream:
 *
 *   - OFAC SDN (US Treasury):
 *       https://www.treasury.gov/ofac/downloads/sdn.xml
 *   - EU consolidated financial sanctions list (XML):
 *       https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content
 *   - UK OFSI consolidated list (CSV):
 *       https://ofsistorage.blob.core.windows.net/publishlive/2022format/ConList.csv
 *   - UN Security Council consolidated list (XML):
 *       https://scsanctions.un.org/resources/xml/en/consolidated.xml
 *
 * Each emitted draft uses:
 *   - `signal_type` = `sanctions_match`
 *   - `value`       = list code (1=OFAC, 2=EU, 3=UK, 4=UN) for fast
 *                     analyzer pivots
 *   - `scope_supplier_name` = primary entity name (sanctions target)
 *   - `scope_sku`           = source-list per-entry id (uniqueness)
 *   - `scope_lane_key`      = country/jurisdiction code
 *   - `entityUid`           = deterministic id derived from list + uid
 *
 * Posture: `public_api`, tier `T1`. Government sources, fully citable.
 *
 * NOTE: We intentionally avoid a heavyweight XML parser and use a
 * targeted regex extractor — the four schemas only share one piece of
 * info (entity name + id + country) and that's all the Foundation
 * needs for entity resolution + matching.
 */

import { z } from "zod";
import {
  buildSignalDraftSchema,
  defaultStableSignalKey,
} from "../contractHelpers";
import type {
  CollectWithRawResult,
  IntelligenceCollector,
  MarketSignalDraft,
  RawPayload,
} from "../collector";
import { logger } from "../../logger";

export const GOVERNMENT_SANCTIONS_COLLECTOR_ID = "government-sanctions";

export const SANCTIONS_LIST_CODES = {
  OFAC: 1,
  EU: 2,
  UK: 3,
  UN: 4,
} as const;
export type SanctionsListCode =
  (typeof SANCTIONS_LIST_CODES)[keyof typeof SANCTIONS_LIST_CODES];

export const SANCTIONS_LIST_SOURCES = {
  OFAC: "https://www.treasury.gov/ofac/downloads/sdn.xml",
  EU: "https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content",
  UK: "https://ofsistorage.blob.core.windows.net/publishlive/2022format/ConList.csv",
  UN: "https://scsanctions.un.org/resources/xml/en/consolidated.xml",
} as const;

export interface SanctionsEntry {
  listCode: SanctionsListCode;
  listName: "OFAC" | "EU" | "UK" | "UN";
  entryId: string;
  name: string;
  type: "Individual" | "Entity" | "Vessel" | "Aircraft" | "Unknown";
  country: string | null;
  program: string | null;
  publishedAt: Date;
}

/**
 * Generic XML extractor — pulls the text content of `<tag>` and
 * accepts arbitrary inner XML (we only use it on simple leaf tags).
 */
function xmlText(xml: string, tag: string): string | null {
  // Require the tag name to be followed by `>` or whitespace so
  // looking up `<program>` doesn't accidentally match the surrounding
  // `<programList>` block.
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  if (!m || !m[1]) return null;
  return m[1].trim().length > 0 ? m[1].trim() : null;
}

/** Parse OFAC SDN XML into SanctionsEntry[]. */
export function parseOfacSdn(xml: string, observedAt: Date): SanctionsEntry[] {
  const entries: SanctionsEntry[] = [];
  const blocks = xml.match(/<sdnEntry>[\s\S]*?<\/sdnEntry>/g) ?? [];
  for (const block of blocks) {
    const uid = xmlText(block, "uid");
    const sdnType = (xmlText(block, "sdnType") ?? "Unknown") as SanctionsEntry["type"];
    const lastName = xmlText(block, "lastName");
    const firstName = xmlText(block, "firstName");
    const name =
      sdnType === "Individual"
        ? [firstName, lastName].filter(Boolean).join(" ").trim()
        : (lastName ?? firstName ?? "");
    if (!uid || !name) continue;
    const program = xmlText(block, "program");
    // Country is buried in addressList; grab the first <country> tag.
    const country = xmlText(block, "country");
    entries.push({
      listCode: SANCTIONS_LIST_CODES.OFAC,
      listName: "OFAC",
      entryId: uid,
      name,
      type: sdnType,
      country,
      program,
      publishedAt: observedAt,
    });
  }
  return entries;
}

/** Parse EU consolidated sanctions XML (subset). */
export function parseEuSanctions(xml: string, observedAt: Date): SanctionsEntry[] {
  const entries: SanctionsEntry[] = [];
  const blocks = xml.match(/<sanctionEntity[^>]*>[\s\S]*?<\/sanctionEntity>/g) ?? [];
  for (const block of blocks) {
    const idMatch = block.match(/<sanctionEntity[^>]*\slogicalId="(\d+)"/);
    const id = idMatch?.[1] ?? null;
    if (!id) continue;
    // EU uses subjectType="person" or subjectType="enterprise".
    const subjectMatch = block.match(/subjectType[^>]*code="([^"]+)"/);
    const code = (subjectMatch?.[1] ?? "").toLowerCase();
    const type: SanctionsEntry["type"] =
      code === "person" ? "Individual" : code === "enterprise" ? "Entity" : "Unknown";
    // First <wholeName> wins.
    const name =
      xmlText(block, "wholeName") ?? xmlText(block, "lastName") ?? null;
    if (!name) continue;
    const program = xmlText(block, "regulation") ?? xmlText(block, "remark");
    const country = xmlText(block, "countryDescription") ?? xmlText(block, "country");
    entries.push({
      listCode: SANCTIONS_LIST_CODES.EU,
      listName: "EU",
      entryId: id,
      name,
      type,
      country,
      program,
      publishedAt: observedAt,
    });
  }
  return entries;
}

/**
 * Parse UK OFSI consolidated list CSV. The file is comma-separated with
 * a multi-row preamble; the relevant data starts after the "Group ID"
 * header row.
 */
export function parseUkOfsiCsv(csv: string, observedAt: Date): SanctionsEntry[] {
  const lines = csv.split(/\r?\n/);
  const entries: SanctionsEntry[] = [];
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.startsWith("Group ID")) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) return entries;
  const header = splitCsvRow(lines[headerIdx]!);
  const idIdx = header.indexOf("Group ID");
  const nameIdx = findHeader(header, ["Name 6", "Name"]);
  const typeIdx = findHeader(header, ["Group Type"]);
  const countryIdx = findHeader(header, ["Country", "Country (Reg)"]);
  const programIdx = findHeader(header, ["Regime", "List of measures"]);
  if (idIdx < 0 || nameIdx < 0) return entries;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const row = lines[i]!;
    if (!row.trim()) continue;
    const cells = splitCsvRow(row);
    const id = cells[idIdx];
    const name = cells[nameIdx];
    if (!id || !name) continue;
    const groupType = (typeIdx >= 0 ? cells[typeIdx] : "") ?? "";
    const type: SanctionsEntry["type"] =
      groupType.toLowerCase() === "individual"
        ? "Individual"
        : groupType.toLowerCase() === "entity"
          ? "Entity"
          : "Unknown";
    entries.push({
      listCode: SANCTIONS_LIST_CODES.UK,
      listName: "UK",
      entryId: id,
      name,
      type,
      country: countryIdx >= 0 ? (cells[countryIdx] ?? null) : null,
      program: programIdx >= 0 ? (cells[programIdx] ?? null) : null,
      publishedAt: observedAt,
    });
  }
  return entries;
}

function findHeader(header: string[], candidates: string[]): number {
  for (const c of candidates) {
    const idx = header.indexOf(c);
    if (idx >= 0) return idx;
  }
  return -1;
}

/**
 * Bare-bones RFC 4180-ish CSV row splitter — handles quoted cells with
 * embedded commas, doubled-quote escapes, and trailing-newline noise.
 * Sufficient for OFSI's well-formed export.
 */
export function splitCsvRow(row: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  let inQ = false;
  while (i < row.length) {
    const ch = row[i]!;
    if (inQ) {
      if (ch === '"') {
        if (row[i + 1] === '"') {
          cur += '"';
          i += 2;
          continue;
        }
        inQ = false;
        i++;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQ = true;
      i++;
      continue;
    }
    if (ch === ",") {
      out.push(cur);
      cur = "";
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

/** Parse UN consolidated sanctions XML (subset). */
export function parseUnSanctions(xml: string, observedAt: Date): SanctionsEntry[] {
  const entries: SanctionsEntry[] = [];
  // Both INDIVIDUAL and ENTITY blocks coexist in the same file.
  const indvBlocks = xml.match(/<INDIVIDUAL>[\s\S]*?<\/INDIVIDUAL>/g) ?? [];
  for (const block of indvBlocks) {
    const id = xmlText(block, "DATAID") ?? xmlText(block, "REFERENCE_NUMBER");
    if (!id) continue;
    const first = xmlText(block, "FIRST_NAME") ?? "";
    const second = xmlText(block, "SECOND_NAME") ?? "";
    const third = xmlText(block, "THIRD_NAME") ?? "";
    const fourth = xmlText(block, "FOURTH_NAME") ?? "";
    const name = [first, second, third, fourth].filter(Boolean).join(" ").trim();
    if (!name) continue;
    entries.push({
      listCode: SANCTIONS_LIST_CODES.UN,
      listName: "UN",
      entryId: id,
      name,
      type: "Individual",
      country: xmlText(block, "NATIONALITY") ?? null,
      program: xmlText(block, "UN_LIST_TYPE"),
      publishedAt: observedAt,
    });
  }
  const entBlocks = xml.match(/<ENTITY>[\s\S]*?<\/ENTITY>/g) ?? [];
  for (const block of entBlocks) {
    const id = xmlText(block, "DATAID") ?? xmlText(block, "REFERENCE_NUMBER");
    const name = xmlText(block, "FIRST_NAME") ?? xmlText(block, "NAME_ORIGINAL_SCRIPT");
    if (!id || !name) continue;
    entries.push({
      listCode: SANCTIONS_LIST_CODES.UN,
      listName: "UN",
      entryId: id,
      name,
      type: "Entity",
      country: xmlText(block, "COUNTRY") ?? null,
      program: xmlText(block, "UN_LIST_TYPE"),
      publishedAt: observedAt,
    });
  }
  return entries;
}

/** Convert SanctionsEntry → MarketSignalDraft. */
export function entryToDraft(
  entry: SanctionsEntry,
  sourceUrl: string,
): MarketSignalDraft {
  return {
    signalType: "sanctions_match",
    scopeSupplierName: entry.name,
    scopeSku: `${entry.listName}:${entry.entryId}`,
    scopeLaneKey: entry.country ?? undefined,
    value: entry.listCode,
    unit: "list_code",
    currency: "USD",
    observedAt: entry.publishedAt,
    sourceUrl,
    confidence: 0.99,
    entityUid: `ent_sanctions_${entry.listName.toLowerCase()}_${entry.entryId}`,
    metadata: {
      listName: entry.listName,
      listCode: entry.listCode,
      entryId: entry.entryId,
      type: entry.type,
      country: entry.country,
      program: entry.program,
    },
  };
}

const sanctionsMetadataSchema = z
  .object({
    listName: z.enum(["OFAC", "EU", "UK", "UN"]),
    listCode: z.number(),
    entryId: z.string().min(1),
    type: z.enum(["Individual", "Entity", "Vessel", "Aircraft", "Unknown"]),
    country: z.string().nullable(),
    program: z.string().nullable(),
  })
  .passthrough();

const sanctionsSignalSchema = buildSignalDraftSchema(sanctionsMetadataSchema);

async function fetchText(url: string): Promise<{ body: string; contentType: string }> {
  const res = await fetch(url, { headers: { "User-Agent": "Procuro Compliance Platform" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const contentType = res.headers.get("content-type") ?? "application/octet-stream";
  return { body: await res.text(), contentType };
}

export const governmentSanctionsCollector: IntelligenceCollector<typeof sanctionsSignalSchema> = {
  id: GOVERNMENT_SANCTIONS_COLLECTOR_ID,
  name: "Government Sanctions Lists (OFAC, EU, UK, UN)",
  description:
    "Polls the four official consolidated sanctions lists (US OFAC SDN, EU FSF, UK OFSI, UN Security Council) and emits one sanctions_match MarketSignal per listed party. Each draft has scope_supplier_name = sanctioned party, scope_sku = source-list entry id, value = list code (1=OFAC, 2=EU, 3=UK, 4=UN).",
  posture: "public-api",
  sourceUrl: SANCTIONS_LIST_SOURCES.OFAC,
  defaultRateLimitRpm: 4,
  // Lists publish daily-ish; pull every 6 hours to stay fresh without
  // hammering official infrastructure.
  defaultScheduleCron: "30 */6 * * *",
  postureClass: "public_api",
  disclosureTier: "T1",
  jurisdiction: "GLOBAL",
  retentionDays: 730,
  tenantOptInDefault: true,
  signalSchema: sanctionsSignalSchema,
  stableSignalKey(draft) {
    return defaultStableSignalKey(GOVERNMENT_SANCTIONS_COLLECTOR_ID, draft);
  },
  async collect(): Promise<MarketSignalDraft[]> {
    return (await this.collectWithRaw!({ since: null })).drafts;
  },
  async collectWithRaw(): Promise<CollectWithRawResult> {
    const observedAt = new Date();
    const drafts: MarketSignalDraft[] = [];
    const rawPayloads: RawPayload[] = [];
    const failures: string[] = [];
    const sources: Array<{
      key: keyof typeof SANCTIONS_LIST_SOURCES;
      parse: (body: string, observedAt: Date) => SanctionsEntry[];
    }> = [
      { key: "OFAC", parse: parseOfacSdn },
      { key: "EU", parse: parseEuSanctions },
      { key: "UK", parse: parseUkOfsiCsv },
      { key: "UN", parse: parseUnSanctions },
    ];
    for (const { key, parse } of sources) {
      const url = SANCTIONS_LIST_SOURCES[key];
      try {
        const { body, contentType } = await fetchText(url);
        const entries = parse(body, observedAt);
        for (const e of entries) drafts.push(entryToDraft(e, url));
        rawPayloads.push({
          name: `government-sanctions-${key.toLowerCase()}`,
          contentType,
          body,
          sourceUrl: url,
          metadata: { listName: key, entries: entries.length },
        });
      } catch (err) {
        failures.push(`${key}: ${err instanceof Error ? err.message : String(err)}`);
        logger.warn(
          { collectorId: GOVERNMENT_SANCTIONS_COLLECTOR_ID, list: key, err },
          "Sanctions list fetch/parse failed",
        );
      }
    }
    if (drafts.length === 0 && failures.length === sources.length) {
      throw new Error(
        `government-sanctions: all four lists failed. Sample: ${failures.slice(0, 2).join("; ")}`,
      );
    }
    return { drafts, rawPayloads };
  },
};
