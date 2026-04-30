import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import Papa from "papaparse";
import {
  useIngestCsvBatch,
  type CsvIngestRequest,
  type StreamCsvResult,
  type IngestCsvStreamEntity,
  getIngestCsvStreamUrl,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Progress } from "@/components/ui/progress";
import {
  Upload,
  FileSpreadsheet,
  CheckCircle2,
  XCircle,
  Loader2,
  X,
  Database,
  Download,
  Zap,
} from "lucide-react";

type EntityKey =
  | "categories"
  | "suppliers"
  | "items"
  | "contracts"
  | "purchaseOrders"
  | "purchaseOrderLines"
  | "invoices"
  | "payments"
  | "shipments";

interface EntityDef {
  key: EntityKey;
  label: string;
  description: string;
  required: string[];
  optional: string[];
  /**
   * Example rows used for the downloadable CSV template. For grouped
   * entities (contracts, purchaseOrders), include 2 rows that share the
   * same `externalId` to demonstrate how grouping works.
   */
  examples: Record<string, string>[];
  /** Convert CSV rows for this entity to the JSON payload shape. */
  toPayload: (rows: Record<string, string>[]) => unknown[];
}

/**
 * Files larger than this are uploaded via the streaming endpoint
 * (`POST /api/ingest/csv-stream`) instead of being parsed in the browser
 * and shipped as a JSON payload. Browser-side `Papa.parse` of multi-million
 * row CSVs causes OOM and JSON request body limits would reject them anyway.
 */
const STREAM_THRESHOLD_BYTES = 5 * 1024 * 1024;

/**
 * Map a page-level entity to the streaming endpoint's entity name. Some page
 * entities (`contracts`, `purchaseOrders`) are header+children grouped JSON
 * and don't have a 1:1 streamable shape, so they always use the JSON path.
 */
const STREAM_ENTITY_FOR: Record<EntityKey, IngestCsvStreamEntity | null> = {
  categories: "categories",
  suppliers: "suppliers",
  items: "items",
  contracts: null,
  purchaseOrders: null,
  // `purchaseOrderLines` always streams; the grouped `purchaseOrders` entity
  // above stays JSON-only because the page joins headers + lines client-side.
  purchaseOrderLines: "po_lines",
  invoices: "invoices",
  payments: "payments",
  shipments: "shipments",
};

/**
 * Entities that *only* support the streaming path. They have no JSON ingest
 * shape because the grouped/header-aware version is handled by sibling
 * entities (e.g. `purchaseOrders` carries headers + grouped lines for small
 * uploads; `purchaseOrderLines` is the row-by-row streaming flavor for the
 * millions-of-lines case).
 */
const STREAM_ONLY: ReadonlySet<EntityKey> = new Set<EntityKey>([
  "purchaseOrderLines",
]);

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// --- helpers -----------------------------------------------------------

function n(s: string | undefined): number | undefined {
  if (s === undefined || s === "") return undefined;
  const v = Number(s);
  return Number.isFinite(v) ? v : undefined;
}

function reqN(s: string | undefined): number {
  const v = n(s);
  return v ?? 0;
}

function bool(s: string | undefined): boolean {
  return s === "true" || s === "1" || s === "yes";
}

function tags(s: string | undefined): string[] {
  if (!s) return [];
  return s
    .split(/[|;,]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

// --- entity definitions ------------------------------------------------

const ENTITIES: EntityDef[] = [
  {
    key: "categories",
    label: "Categories",
    description: "Spend taxonomy.",
    required: ["externalId", "code", "name", "class"],
    optional: [],
    examples: [
      {
        externalId: "CAT-001",
        code: "ELEC-01",
        name: "Electrical Components",
        class: "direct",
      },
    ],
    toPayload: (rows) =>
      rows.map((r) => ({
        externalId: r["externalId"],
        code: r["code"],
        name: r["name"],
        class: (r["class"] as "direct" | "indirect" | "service") || "indirect",
      })),
  },
  {
    key: "suppliers",
    label: "Suppliers",
    description: "Vendor master.",
    required: ["externalId", "name"],
    optional: [
      "countryCode",
      "paymentTermsDays",
      "isStrategic",
      "isPreferred",
      "tags",
    ],
    examples: [
      {
        externalId: "SUP-001",
        name: "Acme Industrial",
        countryCode: "US",
        paymentTermsDays: "30",
        isStrategic: "true",
        isPreferred: "true",
        tags: "electronics|preferred",
      },
    ],
    toPayload: (rows) =>
      rows.map((r) => ({
        externalId: r["externalId"],
        name: r["name"],
        countryCode: r["countryCode"] || undefined,
        paymentTermsDays: r["paymentTermsDays"] || undefined,
        isStrategic: bool(r["isStrategic"]),
        isPreferred: bool(r["isPreferred"]),
        tags: tags(r["tags"]),
      })),
  },
  {
    key: "items",
    label: "Items / SKUs",
    description: "Catalog of purchased items.",
    required: ["externalId", "sku", "description"],
    optional: [
      "categoryExternalId",
      "mfgPartNumber",
      "uom",
      "normalizedKey",
    ],
    examples: [
      {
        externalId: "ITM-001",
        sku: "WDG-100",
        description: "1 inch widget",
        categoryExternalId: "CAT-001",
        mfgPartNumber: "WDG100MFG",
        uom: "EA",
        normalizedKey: "widget-1in",
      },
    ],
    toPayload: (rows) =>
      rows.map((r) => ({
        externalId: r["externalId"],
        sku: r["sku"],
        description: r["description"],
        categoryExternalId: r["categoryExternalId"] || undefined,
        mfgPartNumber: r["mfgPartNumber"] || undefined,
        uom: r["uom"] || undefined,
        normalizedKey: r["normalizedKey"] || undefined,
      })),
  },
  {
    key: "contracts",
    label: "Contracts",
    description:
      "One row per contract item (sku + price). Header fields repeat per row; rows are grouped by externalId.",
    required: [
      "externalId",
      "contractNumber",
      "title",
      "supplierExternalId",
      "startDate",
      "endDate",
      "sku",
      "contractedUnitPriceUsd",
    ],
    optional: [
      "categoryExternalId",
      "paymentTermsDays",
      "referenceIndex",
      "annualBaselineUsd",
    ],
    examples: [
      {
        externalId: "CON-001",
        contractNumber: "MSA-2025-001",
        title: "Acme Master Agreement",
        supplierExternalId: "SUP-001",
        startDate: "2025-01-01",
        endDate: "2026-12-31",
        sku: "WDG-100",
        contractedUnitPriceUsd: "9.50",
        categoryExternalId: "CAT-001",
        paymentTermsDays: "30",
        referenceIndex: "",
        annualBaselineUsd: "120000",
      },
      {
        externalId: "CON-001",
        contractNumber: "MSA-2025-001",
        title: "Acme Master Agreement",
        supplierExternalId: "SUP-001",
        startDate: "2025-01-01",
        endDate: "2026-12-31",
        sku: "WDG-200",
        contractedUnitPriceUsd: "14.00",
        categoryExternalId: "CAT-001",
        paymentTermsDays: "30",
        referenceIndex: "",
        annualBaselineUsd: "120000",
      },
    ],
    toPayload: (rows) => {
      const map = new Map<
        string,
        {
          externalId: string;
          contractNumber: string;
          title: string;
          supplierExternalId: string;
          categoryExternalId?: string;
          startDate: string;
          endDate: string;
          paymentTermsDays?: number;
          referenceIndex?: string;
          annualBaselineUsd?: number;
          items: Array<{ sku: string; contractedUnitPriceUsd: number }>;
        }
      >();
      for (const r of rows) {
        const id = r["externalId"];
        if (!id) continue;
        let c = map.get(id);
        if (!c) {
          c = {
            externalId: id,
            contractNumber: r["contractNumber"] ?? "",
            title: r["title"] ?? "",
            supplierExternalId: r["supplierExternalId"] ?? "",
            categoryExternalId: r["categoryExternalId"] || undefined,
            startDate: r["startDate"] ?? "",
            endDate: r["endDate"] ?? "",
            paymentTermsDays: n(r["paymentTermsDays"]),
            referenceIndex: r["referenceIndex"] || undefined,
            annualBaselineUsd: n(r["annualBaselineUsd"]),
            items: [],
          };
          map.set(id, c);
        }
        if (r["sku"]) {
          c.items.push({
            sku: r["sku"],
            contractedUnitPriceUsd: reqN(r["contractedUnitPriceUsd"]),
          });
        }
      }
      return Array.from(map.values());
    },
  },
  {
    key: "purchaseOrders",
    label: "Purchase Orders",
    description:
      "One row per PO line. Header fields repeat per row; rows are grouped by externalId.",
    required: [
      "externalId",
      "poNumber",
      "supplierExternalId",
      "orderDate",
      "lineNumber",
      "sku",
      "description",
      "spendClass",
      "qty",
      "unitPriceUsd",
    ],
    optional: [
      "contractExternalId",
      "businessUnit",
      "site",
      "categoryExternalId",
      "uom",
    ],
    examples: [
      {
        externalId: "PO-1001",
        poNumber: "PO-2025-1001",
        supplierExternalId: "SUP-001",
        orderDate: "2025-03-01",
        lineNumber: "1",
        sku: "WDG-100",
        description: "1 inch widget",
        spendClass: "direct",
        qty: "100",
        unitPriceUsd: "9.50",
        contractExternalId: "CON-001",
        businessUnit: "Operations",
        site: "Plant-1",
        categoryExternalId: "CAT-001",
        uom: "EA",
      },
      {
        externalId: "PO-1001",
        poNumber: "PO-2025-1001",
        supplierExternalId: "SUP-001",
        orderDate: "2025-03-01",
        lineNumber: "2",
        sku: "WDG-200",
        description: "2 inch widget",
        spendClass: "direct",
        qty: "50",
        unitPriceUsd: "14.00",
        contractExternalId: "CON-001",
        businessUnit: "Operations",
        site: "Plant-1",
        categoryExternalId: "CAT-001",
        uom: "EA",
      },
    ],
    toPayload: (rows) => {
      const map = new Map<
        string,
        {
          externalId: string;
          poNumber: string;
          supplierExternalId: string;
          contractExternalId?: string;
          businessUnit?: string;
          site?: string;
          orderDate: string;
          lines: Array<{
            lineNumber: number;
            sku: string;
            description: string;
            categoryExternalId?: string;
            spendClass: "direct" | "indirect" | "service";
            qty: number;
            uom?: string;
            unitPriceUsd: number;
          }>;
        }
      >();
      for (const r of rows) {
        const id = r["externalId"];
        if (!id) continue;
        let po = map.get(id);
        if (!po) {
          po = {
            externalId: id,
            poNumber: r["poNumber"] ?? "",
            supplierExternalId: r["supplierExternalId"] ?? "",
            contractExternalId: r["contractExternalId"] || undefined,
            businessUnit: r["businessUnit"] || undefined,
            site: r["site"] || undefined,
            orderDate: r["orderDate"] ?? "",
            lines: [],
          };
          map.set(id, po);
        }
        po.lines.push({
          lineNumber: reqN(r["lineNumber"]),
          sku: r["sku"] ?? "",
          description: r["description"] ?? "",
          categoryExternalId: r["categoryExternalId"] || undefined,
          spendClass:
            (r["spendClass"] as "direct" | "indirect" | "service") ||
            "indirect",
          qty: reqN(r["qty"]),
          uom: r["uom"] || undefined,
          unitPriceUsd: reqN(r["unitPriceUsd"]),
        });
      }
      return Array.from(map.values());
    },
  },
  {
    key: "invoices",
    label: "Invoices",
    description: "Supplier invoices.",
    required: [
      "externalId",
      "invoiceNumber",
      "supplierExternalId",
      "invoiceDate",
      "amountUsd",
      "dedupKey",
    ],
    optional: ["poExternalId", "status"],
    examples: [
      {
        externalId: "INV-001",
        invoiceNumber: "INV-2025-001",
        supplierExternalId: "SUP-001",
        invoiceDate: "2025-03-15",
        amountUsd: "1650.00",
        dedupKey: "SUP-001|INV-2025-001|1650.00",
        poExternalId: "PO-1001",
        status: "approved",
      },
    ],
    toPayload: (rows) =>
      rows.map((r) => ({
        externalId: r["externalId"],
        invoiceNumber: r["invoiceNumber"],
        supplierExternalId: r["supplierExternalId"],
        poExternalId: r["poExternalId"] || undefined,
        invoiceDate: r["invoiceDate"],
        amountUsd: reqN(r["amountUsd"]),
        dedupKey: r["dedupKey"],
        status: (r["status"] as
          | "received"
          | "approved"
          | "paid"
          | "disputed"
          | "void"
          | undefined) || undefined,
      })),
  },
  {
    key: "payments",
    label: "Payments",
    description: "Invoice payments.",
    required: [
      "externalId",
      "invoiceExternalId",
      "paidDate",
      "amountUsd",
    ],
    optional: ["paymentTermsDays"],
    examples: [
      {
        externalId: "PMT-001",
        invoiceExternalId: "INV-001",
        paidDate: "2025-04-14",
        amountUsd: "1650.00",
        paymentTermsDays: "30",
      },
    ],
    toPayload: (rows) =>
      rows.map((r) => ({
        externalId: r["externalId"],
        invoiceExternalId: r["invoiceExternalId"],
        paidDate: r["paidDate"],
        amountUsd: reqN(r["amountUsd"]),
        paymentTermsDays: n(r["paymentTermsDays"]),
      })),
  },
  {
    key: "shipments",
    label: "Shipments",
    description: "Inbound freight events.",
    required: [
      "externalId",
      "carrier",
      "mode",
      "laneKey",
      "freightCostUsd",
      "shipDate",
    ],
    optional: [
      "poExternalId",
      "supplierExternalId",
      "originCountry",
      "destCountry",
      "weightKg",
      "incoterms",
    ],
    examples: [
      {
        externalId: "SHP-001",
        carrier: "FedEx Freight",
        mode: "ltl",
        laneKey: "US-CA-TX",
        freightCostUsd: "425.00",
        shipDate: "2025-03-10",
        poExternalId: "PO-1001",
        supplierExternalId: "SUP-001",
        originCountry: "US",
        destCountry: "US",
        weightKg: "320",
        incoterms: "FOB",
      },
    ],
    toPayload: (rows) =>
      rows.map((r) => ({
        externalId: r["externalId"],
        poExternalId: r["poExternalId"] || undefined,
        supplierExternalId: r["supplierExternalId"] || undefined,
        carrier: r["carrier"],
        mode:
          (r["mode"] as
            | "ocean"
            | "air"
            | "ltl"
            | "tl"
            | "parcel"
            | "rail") || "tl",
        laneKey: r["laneKey"],
        originCountry: r["originCountry"] || undefined,
        destCountry: r["destCountry"] || undefined,
        weightKg: n(r["weightKg"]),
        freightCostUsd: reqN(r["freightCostUsd"]),
        incoterms: r["incoterms"] || undefined,
        shipDate: r["shipDate"],
      })),
  },
  {
    // Streaming-only entity: row-by-row PO lines for the millions-of-lines
    // case. The grouped `purchaseOrders` entity above is JSON-only; for very
    // large PO datasets, upload a (small) PO header file via that entity
    // first, then upload the (very large) line-item file here.
    key: "purchaseOrderLines",
    label: "Purchase Order Lines (large)",
    description:
      "Streaming-only. Use for multi-million-row PO line files; upload the matching PO headers via Purchase Orders first.",
    required: ["externalId", "poExternalId", "sku", "qty", "unitPriceUsd"],
    optional: [
      "lineNumber",
      "description",
      "categoryExternalId",
      "categoryCode",
      "spendClass",
      "uom",
      "orderDate",
    ],
    // Streaming-only entities never go through the JSON ingest path; this
    // payload mapper is unused but kept for type symmetry with EntityDef.
    toPayload: () => [],
    examples: [
      {
        externalId: "POL-1001",
        poExternalId: "PO-1001",
        sku: "SKU-100",
        qty: "10",
        unitPriceUsd: "12.50",
        lineNumber: "1",
        description: "Widget A",
        categoryExternalId: "CAT-100",
        categoryCode: "OFF",
        spendClass: "indirect",
        uom: "EA",
        orderDate: "2024-01-15",
      },
    ],
  },
];

// --- per-entity parsed state ------------------------------------------

interface ParsedFile {
  file: File;
  fileName: string;
  fileSize: number;
  /** Only set when the file was fully parsed (small files). */
  rows: Record<string, string>[] | null;
  headers: string[];
  missingRequired: string[];
  /** True when the file will be uploaded via the streaming endpoint. */
  streaming: boolean;
  parseError?: string;
}

async function parseHeadersOnly(file: File): Promise<{
  headers: string[];
  parseError?: string;
}> {
  return new Promise((resolve) => {
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim(),
      preview: 1,
      complete: (results) => {
        resolve({
          headers: results.meta.fields ?? [],
          parseError:
            results.errors.length > 0 ? results.errors[0]?.message : undefined,
        });
      },
      error: (err: Error) => {
        resolve({ headers: [], parseError: err.message });
      },
    });
  });
}

async function parseCsvFileFully(file: File): Promise<{
  rows: Record<string, string>[];
  headers: string[];
  parseError?: string;
}> {
  return new Promise((resolve) => {
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim(),
      complete: (results) => {
        resolve({
          rows: results.data.filter(
            (r) => Object.keys(r).length > 0,
          ) as Record<string, string>[],
          headers: results.meta.fields ?? [],
          parseError:
            results.errors.length > 0 ? results.errors[0]?.message : undefined,
        });
      },
      error: (err: Error) => {
        resolve({ rows: [], headers: [], parseError: err.message });
      },
    });
  });
}

function downloadEntityTemplate(entity: EntityDef) {
  const headers = [...entity.required, ...entity.optional];
  const csv = Papa.unparse({
    fields: headers,
    data: entity.examples.map((row) => headers.map((h) => row[h] ?? "")),
  });
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${entity.key}-template.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function parseCsvFile(
  file: File,
  entityKey: EntityKey,
): Promise<ParsedFile> {
  const canStream = STREAM_ENTITY_FOR[entityKey] !== null;
  // Stream-only entities always stream; size-flexible entities stream only
  // when the file exceeds STREAM_THRESHOLD_BYTES.
  const shouldStream =
    canStream &&
    (STREAM_ONLY.has(entityKey) || file.size > STREAM_THRESHOLD_BYTES);

  if (shouldStream) {
    const { headers, parseError } = await parseHeadersOnly(file);
    return {
      file,
      fileName: file.name,
      fileSize: file.size,
      rows: null,
      headers,
      missingRequired: [],
      streaming: true,
      parseError,
    };
  }

  const { rows, headers, parseError } = await parseCsvFileFully(file);
  return {
    file,
    fileName: file.name,
    fileSize: file.size,
    rows,
    headers,
    missingRequired: [],
    streaming: false,
    parseError,
  };
}

interface UploadProgress {
  loaded: number;
  total: number;
}

/**
 * Stream-upload a single File to `/api/ingest/csv-stream` using XHR so we get
 * upload progress events (the orval-generated `ingestCsvStream` uses fetch
 * which has no upload progress in browsers).
 *
 * Sends `multipart/form-data` with a `file` part, matching the OpenAPI
 * contract. Content-Type is left unset so the browser fills in the
 * `multipart/form-data; boundary=...` automatically.
 */
function uploadCsvStream(args: {
  file: File;
  entity: IngestCsvStreamEntity;
  onProgress?: (p: UploadProgress) => void;
}): Promise<StreamCsvResult> {
  return new Promise((resolve, reject) => {
    const url = getIngestCsvStreamUrl({ entity: args.entity });
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    xhr.responseType = "json";
    const orgId = localStorage.getItem("activeOrgId") ?? "";
    if (orgId) xhr.setRequestHeader("x-org-id", orgId);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && args.onProgress) {
        args.onProgress({ loaded: e.loaded, total: e.total });
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.response as StreamCsvResult);
        return;
      }
      const errMsg =
        (xhr.response &&
          typeof xhr.response === "object" &&
          (xhr.response as { error?: string }).error) ||
        (typeof xhr.response === "string" ? xhr.response : null) ||
        `HTTP ${xhr.status} ${xhr.statusText}`;
      reject(new Error(errMsg));
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.onabort = () => reject(new Error("Upload aborted"));
    const fd = new FormData();
    fd.append("file", args.file);
    xhr.send(fd);
  });
}

interface SuccessResult {
  recordsProcessed: number;
  recordsCreated: number;
  recordsUpdated: number;
  recordsDeleted: number;
  durationMs: number;
}

export default function Ingest() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [parsed, setParsed] = useState<Partial<Record<EntityKey, ParsedFile>>>(
    {},
  );
  const [result, setResult] = useState<SuccessResult | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [streamProgress, setStreamProgress] = useState<
    Partial<Record<EntityKey, UploadProgress>>
  >({});
  const [isStreaming, setIsStreaming] = useState(false);

  const ingestM = useIngestCsvBatch();

  const onPickFile = async (entity: EntityDef, file: File | null) => {
    setResult(null);
    setApiError(null);
    setStreamProgress({});
    if (!file) {
      const next = { ...parsed };
      delete next[entity.key];
      setParsed(next);
      return;
    }
    const p = await parseCsvFile(file, entity.key);
    const missing = entity.required.filter((c) => !p.headers.includes(c));
    setParsed({ ...parsed, [entity.key]: { ...p, missingRequired: missing } });
  };

  const clearEntity = (key: EntityKey) => {
    const next = { ...parsed };
    delete next[key];
    setParsed(next);
    setResult(null);
    setApiError(null);
    setStreamProgress((prev) => {
      const n = { ...prev };
      delete n[key];
      return n;
    });
  };

  const totalRows = useMemo(
    () =>
      Object.values(parsed).reduce(
        (acc, p) => acc + (p?.rows?.length ?? 0),
        0,
      ),
    [parsed],
  );

  const totalStreamingBytes = useMemo(
    () =>
      Object.values(parsed).reduce(
        (acc, p) => acc + (p?.streaming ? p.fileSize : 0),
        0,
      ),
    [parsed],
  );

  const hasErrors = useMemo(
    () =>
      Object.values(parsed).some(
        (p) => p && (p.missingRequired.length > 0 || p.parseError),
      ),
    [parsed],
  );

  const selectedCount = Object.keys(parsed).length;
  const isPending = ingestM.isPending || isStreaming;

  const hasWork = useMemo(
    () =>
      Object.values(parsed).some(
        (p) => p && (p.streaming || (p.rows && p.rows.length > 0)),
      ),
    [parsed],
  );

  const onRun = async () => {
    setResult(null);
    setApiError(null);
    setStreamProgress({});

    // 1. Aggregate non-streaming entities into a single JSON ingest call.
    const jsonPayload: CsvIngestRequest = {};
    let jsonHasContent = false;
    for (const e of ENTITIES) {
      const p = parsed[e.key];
      if (!p || p.streaming || !p.rows || p.rows.length === 0) continue;
      const out = e.toPayload(p.rows) as Array<{ [k: string]: unknown }>;
      (jsonPayload as Record<string, unknown>)[e.key] = out;
      jsonHasContent = true;
    }

    // 2. Run streaming uploads in parallel with the JSON ingest call.
    const streamingEntries = ENTITIES.flatMap((e) => {
      const p = parsed[e.key];
      if (!p || !p.streaming) return [];
      const streamEntity = STREAM_ENTITY_FOR[e.key];
      if (!streamEntity) return [];
      return [{ key: e.key, file: p.file, streamEntity }];
    });

    setIsStreaming(streamingEntries.length > 0);

    const aggregate: SuccessResult = {
      recordsProcessed: 0,
      recordsCreated: 0,
      recordsUpdated: 0,
      recordsDeleted: 0,
      durationMs: 0,
    };

    try {
      const tasks: Array<Promise<unknown>> = [];

      if (jsonHasContent) {
        tasks.push(
          ingestM
            .mutateAsync({ data: jsonPayload })
            .then((resp: unknown) => {
              if (
                resp &&
                typeof resp === "object" &&
                "recordsProcessed" in resp
              ) {
                const r = resp as SuccessResult;
                aggregate.recordsProcessed += r.recordsProcessed;
                aggregate.recordsCreated += r.recordsCreated;
                aggregate.recordsUpdated += r.recordsUpdated;
                aggregate.recordsDeleted += r.recordsDeleted ?? 0;
                aggregate.durationMs += r.durationMs;
              }
            }),
        );
      }

      for (const s of streamingEntries) {
        tasks.push(
          uploadCsvStream({
            file: s.file,
            entity: s.streamEntity,
            onProgress: (p) =>
              setStreamProgress((prev) => ({ ...prev, [s.key]: p })),
          }).then((r) => {
            aggregate.recordsProcessed += r.rowsParsed;
            aggregate.recordsCreated += r.rowsInserted;
            aggregate.durationMs += r.durationMs;
          }),
        );
      }

      await Promise.all(tasks);

      setResult(aggregate);
      toast({
        title: "Import complete",
        description: `${aggregate.recordsCreated.toLocaleString()} records imported${
          streamingEntries.length > 0
            ? ` (${streamingEntries.length} streamed)`
            : ""
        }`,
      });
      qc.invalidateQueries();
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      setApiError(msg);
      toast({
        title: "Import failed",
        description: msg,
        variant: "destructive",
      });
    } finally {
      setIsStreaming(false);
    }
  };

  return (
    <div className="p-8 space-y-6 max-w-7xl">
      <div>
        <h1
          data-testid="text-page-title"
          className="text-3xl font-bold flex items-center gap-2"
        >
          <Database className="w-7 h-7 text-primary" />
          Data Ingest
        </h1>
        <p className="text-muted-foreground mt-1">
          Upload your own purchase orders, invoices, suppliers, and contracts
          as CSV. Validate Procuro on real data without ERP integration.
        </p>
      </div>

      {result && (
        <Alert data-testid="alert-import-success">
          <CheckCircle2 className="w-4 h-4" />
          <AlertTitle>Import complete</AlertTitle>
          <AlertDescription>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-2 text-sm">
              <Stat label="Processed" value={result.recordsProcessed} />
              <Stat label="Created" value={result.recordsCreated} />
              <Stat label="Updated" value={result.recordsUpdated} />
              <Stat label="Duration" value={`${result.durationMs}ms`} />
            </div>
          </AlertDescription>
        </Alert>
      )}

      {apiError && (
        <Alert variant="destructive" data-testid="alert-import-error">
          <XCircle className="w-4 h-4" />
          <AlertTitle>Import failed</AlertTitle>
          <AlertDescription className="font-mono text-xs whitespace-pre-wrap">
            {apiError}
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>Datasets</span>
            <span className="text-sm font-normal text-muted-foreground">
              {selectedCount} file{selectedCount === 1 ? "" : "s"} ·{" "}
              {totalRows.toLocaleString()} rows
              {totalStreamingBytes > 0 && (
                <>
                  {" "}
                  · {formatBytes(totalStreamingBytes)} streaming
                </>
              )}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2">
            {ENTITIES.map((e) => (
              <EntityRow
                key={e.key}
                entity={e}
                parsed={parsed[e.key]}
                progress={streamProgress[e.key]}
                isUploading={isPending}
                onPick={(f) => onPickFile(e, f)}
                onClear={() => clearEntity(e.key)}
              />
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center justify-end gap-3">
        {hasErrors && (
          <span className="text-sm text-destructive">
            Fix validation errors before importing.
          </span>
        )}
        <Button
          data-testid="btn-run-import"
          onClick={onRun}
          disabled={isPending || selectedCount === 0 || hasErrors || !hasWork}
          size="lg"
        >
          {isPending ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              {isStreaming
                ? `Uploading ${formatBytes(totalStreamingBytes)}…`
                : `Importing ${totalRows.toLocaleString()} rows…`}
            </>
          ) : (
            <>
              <Upload className="w-4 h-4 mr-2" />
              Import{" "}
              {totalRows > 0 ? `${totalRows.toLocaleString()} rows` : ""}
              {totalStreamingBytes > 0 && (
                <>
                  {totalRows > 0 ? " + " : ""}
                  {formatBytes(totalStreamingBytes)} large file
                  {Object.values(parsed).filter((p) => p?.streaming).length === 1
                    ? ""
                    : "s"}
                </>
              )}
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

function EntityRow({
  entity,
  parsed,
  progress,
  isUploading,
  onPick,
  onClear,
}: {
  entity: EntityDef;
  parsed?: ParsedFile;
  progress?: UploadProgress;
  isUploading: boolean;
  onPick: (f: File | null) => void;
  onClear: () => void;
}) {
  const hasError = parsed && (parsed.missingRequired.length > 0 || parsed.parseError);
  const ok = parsed && !hasError && (parsed.streaming || (parsed.rows && parsed.rows.length > 0));
  const supportsStream = STREAM_ENTITY_FOR[entity.key] !== null;
  const oversized =
    parsed &&
    !parsed.streaming &&
    !supportsStream &&
    parsed.fileSize > STREAM_THRESHOLD_BYTES;
  const progressPct =
    progress && progress.total > 0
      ? Math.round((progress.loaded / progress.total) * 100)
      : 0;

  return (
    <div
      data-testid={`entity-row-${entity.key}`}
      className="border rounded-md p-4 space-y-3"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <FileSpreadsheet className="w-4 h-4 text-muted-foreground" />
            <span className="font-semibold">{entity.label}</span>
            {ok && parsed.rows && (
              <Badge
                variant="default"
                data-testid={`badge-rows-${entity.key}`}
              >
                {parsed.rows.length.toLocaleString()} rows
              </Badge>
            )}
            {ok && parsed.streaming && (
              <Badge
                variant="secondary"
                data-testid={`badge-streaming-${entity.key}`}
                className="gap-1"
              >
                <Zap className="w-3 h-3" />
                Streaming · {formatBytes(parsed.fileSize)}
              </Badge>
            )}
            {hasError && (
              <Badge variant="destructive">Invalid</Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {entity.description}
          </p>
        </div>
        {parsed && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onClear}
            data-testid={`btn-clear-${entity.key}`}
          >
            <X className="w-4 h-4" />
          </Button>
        )}
      </div>

      <div className="text-xs text-muted-foreground">
        <span className="font-medium">Required:</span>{" "}
        <code className="text-[11px]">{entity.required.join(", ")}</code>
        {entity.optional.length > 0 && (
          <>
            <br />
            <span className="font-medium">Optional:</span>{" "}
            <code className="text-[11px]">{entity.optional.join(", ")}</code>
          </>
        )}
      </div>

      <div>
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto p-0 text-xs"
          onClick={() => downloadEntityTemplate(entity)}
          data-testid={`btn-download-template-${entity.key}`}
        >
          <Download className="w-3 h-3 mr-1" />
          Download template
        </Button>
      </div>

      <Input
        type="file"
        accept=".csv,text/csv"
        data-testid={`input-file-${entity.key}`}
        onChange={(e) => {
          const f = e.target.files?.[0] ?? null;
          onPick(f);
          // reset so same file can be reselected
          e.target.value = "";
        }}
        className="text-sm"
      />

      {parsed?.parseError && (
        <Alert variant="destructive" className="py-2">
          <XCircle className="w-4 h-4" />
          <AlertDescription className="text-xs">
            Parse error: {parsed.parseError}
          </AlertDescription>
        </Alert>
      )}

      {parsed && parsed.missingRequired.length > 0 && (
        <Alert variant="destructive" className="py-2">
          <XCircle className="w-4 h-4" />
          <AlertDescription className="text-xs">
            Missing required column
            {parsed.missingRequired.length === 1 ? "" : "s"}:{" "}
            <code>{parsed.missingRequired.join(", ")}</code>
          </AlertDescription>
        </Alert>
      )}

      {oversized && (
        <Alert className="py-2">
          <Zap className="w-4 h-4" />
          <AlertDescription className="text-xs">
            Large file ({formatBytes(parsed.fileSize)}). This entity does not
            support streaming and may fail. Split the file or import smaller
            batches.
          </AlertDescription>
        </Alert>
      )}

      {parsed?.streaming && isUploading && (
        <div
          className="space-y-1"
          data-testid={`stream-progress-${entity.key}`}
        >
          <Progress value={progressPct} />
          <div className="text-[11px] text-muted-foreground tabular-nums">
            {progress
              ? `${formatBytes(progress.loaded)} / ${formatBytes(progress.total)} · ${progressPct}%`
              : "Uploading…"}
          </div>
        </div>
      )}

      {parsed && (
        <div className="text-xs text-muted-foreground">
          <span className="font-medium">{parsed.fileName}</span> ·{" "}
          {formatBytes(parsed.fileSize)} ·{" "}
          {parsed.headers.length} column{parsed.headers.length === 1 ? "" : "s"}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}
