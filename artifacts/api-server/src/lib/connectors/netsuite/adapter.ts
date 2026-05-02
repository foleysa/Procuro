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
  type NetSuiteContract,
  type NetSuiteInvoice,
  type NetSuitePayment,
  type NetSuitePurchaseOrder,
  type NetSuiteVendor,
} from "./mapping";

/**
 * NetSuite SuiteTalk REST + OAuth2 client-credentials adapter.
 *
 * Wire format quirks worth knowing:
 *
 * - The instance URL is derived from the account id: a NetSuite
 *   account `1234567` lives at
 *   `https://1234567.suitetalk.api.netsuite.com`. Sandbox accounts
 *   carry `_SB1` in the id (`1234567_SB1`); the host strips the
 *   underscore and lower-cases (`1234567-sb1`).
 * - Authentication is OAuth2 client-credentials at
 *   `<host>/services/rest/auth/oauth2/v1/token`. We use the simpler
 *   client-secret variant; signed-JWT is left for a follow-up because
 *   it requires an uploaded certificate.
 * - All payloads are camelCase JSON; no kebab→camel conversion needed.
 * - Pagination uses `?offset=&limit=` and the response carries a
 *   `hasMore` flag plus `count`/`totalResults`. We page until
 *   `hasMore` is false (or fewer than `pageSize` rows arrive — same
 *   safety net as Coupa).
 * - Watermark filtering uses SuiteQL syntax via the `q` query
 *   parameter: `lastModifiedDate AFTER "<iso>"`.
 */

// ---------- Schemas ----------

export const netsuiteCredentialsSchema = z.object({
  clientId: z.string().min(1, "clientId is required"),
  clientSecret: z.string().min(1, "clientSecret is required"),
});

export const netsuiteSettingsSchema = z.object({
  /** NetSuite account id, e.g. `1234567` or `1234567_SB1`. */
  accountId: z
    .string()
    .min(1, "accountId is required")
    .regex(
      /^[A-Za-z0-9_-]+$/,
      "accountId must only contain letters, digits, _ or -",
    ),
  /**
   * Optional explicit instance URL override. When omitted we derive
   * `https://<accountId-normalised>.suitetalk.api.netsuite.com`.
   */
  instanceUrl: z
    .string()
    .url("instanceUrl must be a valid URL")
    .refine(
      (u) => !u.endsWith("/"),
      "instanceUrl must not have a trailing slash",
    )
    .optional(),
  /** Page size used in `?limit=`. Defaults to 200, capped at 1000. */
  pageSize: z.number().int().min(1).max(1000).default(200),
  /** Optional override of the OAuth scope list. */
  scope: z.string().default("rest_webservices"),
});

export type NetSuiteCredentials = z.infer<typeof netsuiteCredentialsSchema>;
export type NetSuiteSettings = z.infer<typeof netsuiteSettingsSchema>;

function instanceUrlFor(settings: NetSuiteSettings): string {
  if (settings.instanceUrl) return settings.instanceUrl;
  const host = settings.accountId.toLowerCase().replace(/_/g, "-");
  return `https://${host}.suitetalk.api.netsuite.com`;
}

// ---------- Token ----------

interface NetSuiteToken {
  accessToken: string;
  expiresAt: number;
}

async function fetchToken(
  fetchImpl: typeof fetch,
  settings: NetSuiteSettings,
  creds: NetSuiteCredentials,
): Promise<NetSuiteToken> {
  const url = `${instanceUrlFor(settings)}/services/rest/auth/oauth2/v1/token`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      scope: settings.scope,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `NetSuite OAuth token request failed: ${res.status} ${body.slice(0, 200)}`,
    );
  }
  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) {
    throw new Error("NetSuite OAuth response missing access_token");
  }
  return {
    accessToken: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 - 60_000,
  };
}

// ---------- Paged fetch ----------

interface PageArgs {
  fetchImpl: typeof fetch;
  settings: NetSuiteSettings;
  token: NetSuiteToken;
  resource: string;
  /** Watermark column for this resource — usually `lastModifiedDate`. */
  watermarkField: string;
  since?: string | null;
}

interface NetSuiteListResponse<T> {
  items?: T[];
  hasMore?: boolean;
  count?: number;
  totalResults?: number;
}

async function* pagedFetch<T>(args: PageArgs): AsyncGenerator<{
  rows: T[];
  page: number;
}> {
  const { fetchImpl, settings, token, resource, since, watermarkField } = args;
  let offset = 0;
  let page = 0;
  const HARD_PAGE_LIMIT = 200;
  const base = instanceUrlFor(settings);
  while (page < HARD_PAGE_LIMIT) {
    const url = new URL(`${base}/services/rest/record/v1/${resource}`);
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("limit", String(settings.pageSize));
    if (since) {
      url.searchParams.set("q", `${watermarkField} AFTER "${since}"`);
    }
    const res = await fetchImpl(url.toString(), {
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `NetSuite GET ${resource} failed: ${res.status} ${body.slice(0, 200)}`,
      );
    }
    const json = (await res.json()) as NetSuiteListResponse<T>;
    const rows = json.items ?? [];
    yield { rows, page: page + 1 };
    const more =
      json.hasMore === true ||
      (json.hasMore === undefined && rows.length === settings.pageSize);
    if (!more) return;
    offset += settings.pageSize;
    page += 1;
  }
}

// ---------- Watermark math ----------

function maxWatermark(
  rows: Array<{ lastModifiedDate?: string | null }>,
  fallback: string | null | undefined,
): string | undefined {
  let max = fallback ? new Date(fallback).getTime() : -Infinity;
  for (const r of rows) {
    if (!r.lastModifiedDate) continue;
    const t = new Date(r.lastModifiedDate).getTime();
    if (Number.isFinite(t) && t > max) max = t;
  }
  if (!Number.isFinite(max) || max < 0) return undefined;
  return new Date(max).toISOString();
}

// ---------- Connector ----------

export const netsuiteConnector: ErpConnector<
  typeof netsuiteCredentialsSchema,
  typeof netsuiteSettingsSchema
> = {
  key: "netsuite",
  label: "NetSuite",
  description:
    "Sync vendors, contracts, purchase orders, vendor bills, and vendor payments from a NetSuite account via SuiteTalk REST + OAuth2 client-credentials.",
  postureClass: "public_api",
  disclosureTier: "T2",
  jurisdiction: "US",
  retentionDays: 365,
  credentialsSchema: netsuiteCredentialsSchema,
  settingsSchema: netsuiteSettingsSchema,

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

    const allVendors: NetSuiteVendor[] = [];
    const allContracts: NetSuiteContract[] = [];
    const allPos: NetSuitePurchaseOrder[] = [];
    const allInvoices: NetSuiteInvoice[] = [];
    const allPayments: NetSuitePayment[] = [];

    const checkpoint = async (): Promise<void> => {
      if (isCancelled && (await isCancelled())) {
        throw new Error("CANCELLED");
      }
    };

    // Vendors
    for await (const { rows, page } of pagedFetch<NetSuiteVendor>({
      fetchImpl: f,
      settings,
      token,
      resource: "vendor",
      watermarkField: "lastModifiedDate",
      since: watermarks.suppliers,
    })) {
      allVendors.push(...rows);
      pagesByEntity.suppliers = page;
      recordsByEntity.suppliers =
        (recordsByEntity.suppliers ?? 0) + rows.length;
      await checkpoint();
    }

    // Contracts (NetSuite "Contract" is a custom record in many
    // accounts; the resource path is conventional).
    for await (const { rows, page } of pagedFetch<NetSuiteContract>({
      fetchImpl: f,
      settings,
      token,
      resource: "contract",
      watermarkField: "lastModifiedDate",
      since: watermarks.contracts,
    })) {
      allContracts.push(...rows);
      pagesByEntity.contracts = page;
      recordsByEntity.contracts =
        (recordsByEntity.contracts ?? 0) + rows.length;
      await checkpoint();
    }

    // Purchase orders
    for await (const { rows, page } of pagedFetch<NetSuitePurchaseOrder>({
      fetchImpl: f,
      settings,
      token,
      resource: "purchaseOrder",
      watermarkField: "lastModifiedDate",
      since: watermarks.purchase_orders,
    })) {
      allPos.push(...rows);
      pagesByEntity.purchase_orders = page;
      recordsByEntity.purchase_orders =
        (recordsByEntity.purchase_orders ?? 0) + rows.length;
      await checkpoint();
    }

    // Vendor bills (invoices)
    for await (const { rows, page } of pagedFetch<NetSuiteInvoice>({
      fetchImpl: f,
      settings,
      token,
      resource: "vendorBill",
      watermarkField: "lastModifiedDate",
      since: watermarks.invoices,
    })) {
      allInvoices.push(...rows);
      pagesByEntity.invoices = page;
      recordsByEntity.invoices =
        (recordsByEntity.invoices ?? 0) + rows.length;
      await checkpoint();
    }

    // Vendor payments
    for await (const { rows, page } of pagedFetch<NetSuitePayment>({
      fetchImpl: f,
      settings,
      token,
      resource: "vendorPayment",
      watermarkField: "lastModifiedDate",
      since: watermarks.payments,
    })) {
      allPayments.push(...rows);
      pagesByEntity.payments = page;
      recordsByEntity.payments =
        (recordsByEntity.payments ?? 0) + rows.length;
      await checkpoint();
    }

    const { payload } = buildIngestPayload({
      vendors: allVendors,
      contracts: allContracts,
      purchaseOrders: allPos,
      invoices: allInvoices,
      payments: allPayments,
    });

    const nextWatermarks: ErpWatermarks = {};
    const setWm = (k: string, v: string | undefined): void => {
      if (v) nextWatermarks[k] = v;
    };
    setWm("suppliers", maxWatermark(allVendors, watermarks["suppliers"]));
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
