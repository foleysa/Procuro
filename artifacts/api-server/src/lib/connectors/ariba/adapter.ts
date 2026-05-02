import { z } from "zod";
import type { ErpWatermarks } from "@workspace/db";
import type {
  ErpConnector,
  ErpEntity,
  ErpFetchResult,
} from "../erp-connector";
import type { IngestPayload } from "../../adapters/ingest-writer";
import {
  buildIngestPayload,
  type AribaContract,
  type AribaInvoice,
  type AribaPayment,
  type AribaPurchaseOrder,
  type AribaSupplier,
} from "./mapping";

/**
 * SAP Ariba Operational Reporting + OAuth2 client-credentials adapter.
 *
 * Wire format quirks worth knowing:
 *
 * - Authentication is OAuth2 client-credentials at
 *   `<authUrl>/v2/oauth/token` (defaults to
 *   `https://api.ariba.com`). The platform also requires every
 *   request to carry an `apikey` header — provided in credentials,
 *   not in the OAuth flow.
 * - Per-realm endpoint structure: every record GET is scoped to a
 *   `?realm=<realm>` query param. The realm names a single tenant on
 *   the Ariba network (e.g. `acme-prod`).
 * - All payloads are camelCase JSON; no normalisation needed.
 * - Pagination uses `?$skip=&$top=` (OData-style) with a
 *   `pagingNextToken` continuation token in the response body. We
 *   prefer the token when present and fall back to `$skip` math.
 * - Watermark filtering uses OData `$filter` syntax:
 *   `lastUpdatedTime gt <iso>`.
 */

// ---------- Schemas ----------

export const aribaCredentialsSchema = z.object({
  /** Per-tenant API key — sent on every request as `apikey`. */
  apiKey: z.string().min(1, "apiKey is required"),
  /** OAuth2 client id. */
  clientId: z.string().min(1, "clientId is required"),
  /** OAuth2 client secret. */
  clientSecret: z.string().min(1, "clientSecret is required"),
});

export const aribaSettingsSchema = z.object({
  /**
   * API instance URL — typically `https://openapi.ariba.com` for
   * production or `https://openapi-sandbox.ariba.com` for sandbox.
   * No trailing slash.
   */
  instanceUrl: z
    .string()
    .url("instanceUrl must be a valid URL")
    .refine(
      (u) => !u.endsWith("/"),
      "instanceUrl must not have a trailing slash",
    ),
  /** Realm / site identifier (`acme-prod`, `globex-test`, …). */
  realm: z
    .string()
    .min(1, "realm is required")
    .regex(
      /^[A-Za-z0-9_.-]+$/,
      "realm must only contain letters, digits, _ . or -",
    ),
  /**
   * Optional authentication URL override. Defaults to
   * `https://api.ariba.com` (the global token endpoint).
   */
  authUrl: z
    .string()
    .url("authUrl must be a valid URL")
    .refine((u) => !u.endsWith("/"), "authUrl must not have a trailing slash")
    .default("https://api.ariba.com"),
  /** Page size used in `$top=`. Defaults to 200, capped at 500. */
  pageSize: z.number().int().min(1).max(500).default(200),
});

export type AribaCredentials = z.infer<typeof aribaCredentialsSchema>;
export type AribaSettings = z.infer<typeof aribaSettingsSchema>;

// ---------- Token ----------

interface AribaToken {
  accessToken: string;
  expiresAt: number;
}

async function fetchToken(
  fetchImpl: typeof fetch,
  settings: AribaSettings,
  creds: AribaCredentials,
): Promise<AribaToken> {
  const basic = Buffer.from(
    `${creds.clientId}:${creds.clientSecret}`,
  ).toString("base64");
  const res = await fetchImpl(`${settings.authUrl}/v2/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
      apikey: creds.apiKey,
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Ariba OAuth token request failed: ${res.status} ${body.slice(0, 200)}`,
    );
  }
  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) {
    throw new Error("Ariba OAuth response missing access_token");
  }
  return {
    accessToken: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 - 60_000,
  };
}

// ---------- Paged fetch ----------

interface PageArgs {
  fetchImpl: typeof fetch;
  settings: AribaSettings;
  creds: AribaCredentials;
  token: AribaToken;
  resource: string;
  since?: string | null;
}

interface AribaListResponse<T> {
  items?: T[];
  pagingNextToken?: string | null;
  totalCount?: number;
}

async function* pagedFetch<T>(args: PageArgs): AsyncGenerator<{
  rows: T[];
  page: number;
}> {
  const { fetchImpl, settings, creds, token, resource, since } = args;
  let skip = 0;
  let page = 0;
  let nextToken: string | null = null;
  const HARD_PAGE_LIMIT = 200;
  while (page < HARD_PAGE_LIMIT) {
    const url = new URL(`${settings.instanceUrl}/api/${resource}`);
    url.searchParams.set("realm", settings.realm);
    url.searchParams.set("$top", String(settings.pageSize));
    if (nextToken) {
      url.searchParams.set("pagingNextToken", nextToken);
    } else {
      url.searchParams.set("$skip", String(skip));
    }
    if (since) {
      url.searchParams.set("$filter", `lastUpdatedTime gt ${since}`);
    }
    const res = await fetchImpl(url.toString(), {
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        apikey: creds.apiKey,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Ariba GET ${resource} failed: ${res.status} ${body.slice(0, 200)}`,
      );
    }
    const json = (await res.json()) as AribaListResponse<T>;
    const rows = json.items ?? [];
    yield { rows, page: page + 1 };
    if (json.pagingNextToken) {
      nextToken = json.pagingNextToken;
    } else {
      if (rows.length < settings.pageSize) return;
      skip += settings.pageSize;
      nextToken = null;
    }
    page += 1;
  }
}

// ---------- Watermark math ----------

function maxWatermark(
  rows: Array<{ lastUpdatedTime?: string | null }>,
  fallback: string | null | undefined,
): string | undefined {
  let max = fallback ? new Date(fallback).getTime() : -Infinity;
  for (const r of rows) {
    if (!r.lastUpdatedTime) continue;
    const t = new Date(r.lastUpdatedTime).getTime();
    if (Number.isFinite(t) && t > max) max = t;
  }
  if (!Number.isFinite(max) || max < 0) return undefined;
  return new Date(max).toISOString();
}

// ---------- Connector ----------

export const aribaConnector: ErpConnector<
  typeof aribaCredentialsSchema,
  typeof aribaSettingsSchema
> = {
  key: "ariba",
  label: "SAP Ariba",
  description:
    "Sync suppliers, contracts, purchase orders, invoices, and payments from a SAP Ariba realm via the Operational Reporting API + OAuth2 client-credentials.",
  postureClass: "public_api",
  disclosureTier: "T2",
  jurisdiction: "EU",
  retentionDays: 365,
  credentialsSchema: aribaCredentialsSchema,
  settingsSchema: aribaSettingsSchema,

  async testConnection({ credentials, settings, fetchImpl }) {
    const f = fetchImpl ?? fetch;
    try {
      await fetchToken(f, settings, credentials);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  async fetchAll({
    credentials,
    settings,
    watermarks,
    isCancelled,
    fetchImpl,
  }): Promise<ErpFetchResult> {
    const f = fetchImpl ?? fetch;
    const token = await fetchToken(f, settings, credentials);

    const pagesByEntity: Partial<Record<ErpEntity, number>> = {};
    const recordsByEntity: Partial<Record<ErpEntity, number>> = {};

    const allSuppliers: AribaSupplier[] = [];
    const allContracts: AribaContract[] = [];
    const allPos: AribaPurchaseOrder[] = [];
    const allInvoices: AribaInvoice[] = [];
    const allPayments: AribaPayment[] = [];

    const checkpoint = async (): Promise<void> => {
      if (isCancelled && (await isCancelled())) {
        throw new Error("CANCELLED");
      }
    };

    // Suppliers
    for await (const { rows, page } of pagedFetch<AribaSupplier>({
      fetchImpl: f,
      settings,
      creds: credentials,
      token,
      resource: "sourcing/v1/suppliers",
      since: watermarks.suppliers,
    })) {
      allSuppliers.push(...rows);
      pagesByEntity.suppliers = page;
      recordsByEntity.suppliers =
        (recordsByEntity.suppliers ?? 0) + rows.length;
      await checkpoint();
    }

    // Contracts
    for await (const { rows, page } of pagedFetch<AribaContract>({
      fetchImpl: f,
      settings,
      creds: credentials,
      token,
      resource: "contracts/v1/contracts",
      since: watermarks.contracts,
    })) {
      allContracts.push(...rows);
      pagesByEntity.contracts = page;
      recordsByEntity.contracts =
        (recordsByEntity.contracts ?? 0) + rows.length;
      await checkpoint();
    }

    // Purchase orders
    for await (const { rows, page } of pagedFetch<AribaPurchaseOrder>({
      fetchImpl: f,
      settings,
      creds: credentials,
      token,
      resource: "procurement/v1/purchaseOrders",
      since: watermarks.purchase_orders,
    })) {
      allPos.push(...rows);
      pagesByEntity.purchase_orders = page;
      recordsByEntity.purchase_orders =
        (recordsByEntity.purchase_orders ?? 0) + rows.length;
      await checkpoint();
    }

    // Invoices
    for await (const { rows, page } of pagedFetch<AribaInvoice>({
      fetchImpl: f,
      settings,
      creds: credentials,
      token,
      resource: "procurement/v1/invoices",
      since: watermarks.invoices,
    })) {
      allInvoices.push(...rows);
      pagesByEntity.invoices = page;
      recordsByEntity.invoices =
        (recordsByEntity.invoices ?? 0) + rows.length;
      await checkpoint();
    }

    // Payments
    for await (const { rows, page } of pagedFetch<AribaPayment>({
      fetchImpl: f,
      settings,
      creds: credentials,
      token,
      resource: "procurement/v1/payments",
      since: watermarks.payments,
    })) {
      allPayments.push(...rows);
      pagesByEntity.payments = page;
      recordsByEntity.payments =
        (recordsByEntity.payments ?? 0) + rows.length;
      await checkpoint();
    }

    const { payload } = buildIngestPayload({
      suppliers: allSuppliers,
      contracts: allContracts,
      purchaseOrders: allPos,
      invoices: allInvoices,
      payments: allPayments,
    });

    const nextWatermarks: ErpWatermarks = {};
    const setWm = (k: string, v: string | undefined): void => {
      if (v) nextWatermarks[k] = v;
    };
    setWm("suppliers", maxWatermark(allSuppliers, watermarks["suppliers"]));
    setWm("contracts", maxWatermark(allContracts, watermarks["contracts"]));
    setWm(
      "purchase_orders",
      maxWatermark(allPos, watermarks["purchase_orders"]),
    );
    setWm("invoices", maxWatermark(allInvoices, watermarks["invoices"]));
    setWm("payments", maxWatermark(allPayments, watermarks["payments"]));

    return {
      payload,
      nextWatermarks,
      pagesByEntity,
      recordsByEntity,
    } satisfies ErpFetchResult & { payload: IngestPayload };
  },
};
