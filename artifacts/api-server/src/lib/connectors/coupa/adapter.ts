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
  type CoupaContract,
  type CoupaInvoice,
  type CoupaPayment,
  type CoupaPurchaseOrder,
  type CoupaSupplier,
} from "./mapping";

/**
 * Coupa REST + OAuth2 client-credentials adapter.
 *
 * Wire format quirks worth knowing:
 *
 * - Authentication is OAuth2 client-credentials at
 *   `<host>/oauth2/token` with body
 *   `grant_type=client_credentials&scope=core.supplier.read core.contract.read core.purchase_order.read core.invoice.read core.payment.read`.
 * - All payloads come back kebab-cased (`updated-at`,
 *   `payment-terms`); we normalise to camelCase before invoking the
 *   pure mapping module.
 * - Pagination uses `?offset=&limit=` and there is **no** `next` link
 *   header — we keep paging until a response is returned with fewer
 *   than `limit` rows.
 * - Watermark is the `updated-at` field, requested via
 *   `?updated-at[gt]=<iso>`.
 *
 * The connector is deliberately I/O-light: parsing/mapping lives in
 * `mapping.ts` so unit tests can pin field-by-field behaviour without
 * mocking fetch.
 */

// ---------- Schemas ----------

export const coupaCredentialsSchema = z.object({
  clientId: z.string().min(1, "clientId is required"),
  clientSecret: z.string().min(1, "clientSecret is required"),
});

export const coupaSettingsSchema = z.object({
  /** e.g. `https://acme.coupahost.com`. No trailing slash. */
  instanceUrl: z
    .string()
    .url("instanceUrl must be a valid URL")
    .refine((u) => !u.endsWith("/"), "instanceUrl must not have a trailing slash"),
  /** Page size used in `?limit=`. Defaults to 200, capped at 500. */
  pageSize: z.number().int().min(1).max(500).default(200),
  /** Optional override of the OAuth scope list. */
  scope: z
    .string()
    .default(
      "core.supplier.read core.contract.read core.purchase_order.read core.invoice.read core.payment.read",
    ),
});

export type CoupaCredentials = z.infer<typeof coupaCredentialsSchema>;
export type CoupaSettings = z.infer<typeof coupaSettingsSchema>;

// ---------- Token ----------

interface CoupaToken {
  accessToken: string;
  expiresAt: number;
}

async function fetchToken(
  fetchImpl: typeof fetch,
  settings: CoupaSettings,
  creds: CoupaCredentials,
): Promise<CoupaToken> {
  const res = await fetchImpl(`${settings.instanceUrl}/oauth2/token`, {
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
    throw new Error(`Coupa OAuth token request failed: ${res.status} ${body}`);
  }
  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) {
    throw new Error("Coupa OAuth response missing access_token");
  }
  return {
    accessToken: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 - 60_000,
  };
}

// ---------- kebab→camel normaliser ----------

function camelKey(key: string): string {
  return key.replace(/-([a-z0-9])/gi, (_m, c: string) => c.toUpperCase());
}

function camelize(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(camelize);
  if (input && typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[camelKey(k)] = camelize(v);
    }
    return out;
  }
  return input;
}

// ---------- Paged fetch ----------

interface PageArgs {
  fetchImpl: typeof fetch;
  settings: CoupaSettings;
  token: CoupaToken;
  resource: string;
  since?: string | null;
}

async function* pagedFetch<T>(args: PageArgs): AsyncGenerator<{
  rows: T[];
  page: number;
}> {
  const { fetchImpl, settings, token, resource, since } = args;
  let offset = 0;
  let page = 0;
  // Coupa-side cap so a runaway sync can't loop forever; F500-scale
  // tenants should still complete since each page brings up to 500
  // records → 100k records max per entity per sync.
  const HARD_PAGE_LIMIT = 200;
  while (page < HARD_PAGE_LIMIT) {
    const url = new URL(`${settings.instanceUrl}/api/${resource}`);
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("limit", String(settings.pageSize));
    if (since) url.searchParams.set("updated-at[gt]", since);
    const res = await fetchImpl(url.toString(), {
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Coupa GET ${resource} failed: ${res.status} ${body.slice(0, 200)}`,
      );
    }
    const json = (await res.json()) as unknown;
    const rows = (camelize(json) as T[]) ?? [];
    yield { rows, page: page + 1 };
    if (rows.length < settings.pageSize) return;
    offset += settings.pageSize;
    page += 1;
  }
}

// ---------- Watermark math ----------

function maxWatermark(
  rows: Array<{ updatedAt?: string | null }>,
  fallback: string | null | undefined,
): string | undefined {
  let max = fallback ? new Date(fallback).getTime() : -Infinity;
  for (const r of rows) {
    if (!r.updatedAt) continue;
    const t = new Date(r.updatedAt).getTime();
    if (Number.isFinite(t) && t > max) max = t;
  }
  if (!Number.isFinite(max) || max < 0) return undefined;
  return new Date(max).toISOString();
}

// ---------- Connector ----------

export const coupaConnector: ErpConnector<
  typeof coupaCredentialsSchema,
  typeof coupaSettingsSchema
> = {
  key: "coupa",
  label: "Coupa",
  description:
    "Sync suppliers, contracts, purchase orders, invoices, and payments from a Coupa instance via OAuth2 client-credentials.",
  postureClass: "public_api",
  disclosureTier: "T2",
  jurisdiction: "US",
  retentionDays: 365,
  credentialsSchema: coupaCredentialsSchema,
  settingsSchema: coupaSettingsSchema,

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

    const allSuppliers: CoupaSupplier[] = [];
    const allContracts: CoupaContract[] = [];
    const allPos: CoupaPurchaseOrder[] = [];
    const allInvoices: CoupaInvoice[] = [];
    const allPayments: CoupaPayment[] = [];

    const checkpoint = async (): Promise<void> => {
      if (isCancelled && (await isCancelled())) {
        throw new Error("CANCELLED");
      }
    };

    // Suppliers
    for await (const { rows, page } of pagedFetch<CoupaSupplier>({
      fetchImpl: f,
      settings,
      token,
      resource: "suppliers",
      since: watermarks.suppliers,
    })) {
      allSuppliers.push(...rows);
      pagesByEntity.suppliers = page;
      recordsByEntity.suppliers = (recordsByEntity.suppliers ?? 0) + rows.length;
      await checkpoint();
    }

    // Contracts
    for await (const { rows, page } of pagedFetch<CoupaContract>({
      fetchImpl: f,
      settings,
      token,
      resource: "contracts",
      since: watermarks.contracts,
    })) {
      allContracts.push(...rows);
      pagesByEntity.contracts = page;
      recordsByEntity.contracts = (recordsByEntity.contracts ?? 0) + rows.length;
      await checkpoint();
    }

    // Purchase orders (each PO carries its own `lines`)
    for await (const { rows, page } of pagedFetch<CoupaPurchaseOrder>({
      fetchImpl: f,
      settings,
      token,
      resource: "purchase_orders",
      since: watermarks.purchase_orders,
    })) {
      allPos.push(...rows);
      pagesByEntity.purchase_orders = page;
      recordsByEntity.purchase_orders =
        (recordsByEntity.purchase_orders ?? 0) + rows.length;
      await checkpoint();
    }

    // Invoices
    for await (const { rows, page } of pagedFetch<CoupaInvoice>({
      fetchImpl: f,
      settings,
      token,
      resource: "invoices",
      since: watermarks.invoices,
    })) {
      allInvoices.push(...rows);
      pagesByEntity.invoices = page;
      recordsByEntity.invoices = (recordsByEntity.invoices ?? 0) + rows.length;
      await checkpoint();
    }

    // Payments
    for await (const { rows, page } of pagedFetch<CoupaPayment>({
      fetchImpl: f,
      settings,
      token,
      resource: "payments",
      since: watermarks.payments,
    })) {
      allPayments.push(...rows);
      pagesByEntity.payments = page;
      recordsByEntity.payments = (recordsByEntity.payments ?? 0) + rows.length;
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
