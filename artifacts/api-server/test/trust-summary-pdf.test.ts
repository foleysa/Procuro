/**
 * Smoke test for `GET /api/trust/summary.pdf` (task #168).
 *
 * The PDF endpoint is the user-visible "Download PDF" action on the
 * Trust Center. We don't try to parse the PDF (that's pdfkit's
 * contract); instead we pin the externally-observable behaviour:
 *
 *  1. 200 OK with `application/pdf` for an authenticated read_only key.
 *  2. The body is a real PDF (starts with `%PDF-` magic bytes) and
 *     non-trivial in size — guards against accidental empty buffers.
 *  3. The Content-Disposition filename matches the documented format
 *     `procuro-trust-{org-slug}-{yyyy-mm-dd}.pdf` so the file lands
 *     with the right name in the user's Downloads folder.
 *  4. Unauthenticated requests are rejected with 401 (mirrors the JSON
 *     summary route — no PDF leaks without auth).
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env["NODE_ENV"] = process.env["NODE_ENV"] ?? "development";
delete process.env["ALLOW_DEV_TENANT_HEADER"];

import {
  db,
  orgsTable,
  apiKeysTable,
  type UserRoleName,
} from "@workspace/db";
import app from "../src/app";
import { generateToken } from "../src/lib/auth";
import { newId } from "../src/lib/ids";

interface Handle {
  port: number;
  close: () => Promise<void>;
}

async function startServer(): Promise<Handle> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    server.close();
    throw new Error("Could not bind ephemeral port");
  }
  return {
    port: addr.port,
    close: () =>
      new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function pickOrgId(): Promise<string> {
  const rows = await db.select({ id: orgsTable.id }).from(orgsTable).limit(1);
  if (rows.length === 0) throw new Error("No org seeded; cannot run trust pdf tests");
  return rows[0]!.id;
}

async function issueKey(orgId: string, scopeRole: UserRoleName): Promise<string> {
  const { plain, hash } = generateToken();
  await db.insert(apiKeysTable).values({
    id: newId("ak"),
    orgId,
    label: `trust-pdf-test-${scopeRole}-${Date.now()}`,
    prefix: plain.slice(0, 12),
    tokenHash: hash,
    scopeRole,
    createdBy: "trust-pdf-test@procuro.ai",
  });
  return plain;
}

test("GET /api/trust/summary.pdf returns a PDF with the documented filename", async () => {
  const orgId = await pickOrgId();
  const token = await issueKey(orgId, "read_only");
  const handle = await startServer();
  try {
    const res = await fetch(
      `http://127.0.0.1:${handle.port}/api/trust/summary.pdf`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    assert.equal(
      res.headers.get("content-type"),
      "application/pdf",
      `expected content-type application/pdf, got ${res.headers.get("content-type")}`,
    );
    const disposition = res.headers.get("content-disposition") ?? "";
    assert.match(
      disposition,
      /^attachment;\s*filename="procuro-trust-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.pdf"$/,
      `unexpected Content-Disposition: ${disposition}`,
    );

    const buf = Buffer.from(await res.arrayBuffer());
    assert.ok(buf.length > 1000, `pdf body suspiciously small: ${buf.length} bytes`);
    assert.equal(
      buf.subarray(0, 5).toString("ascii"),
      "%PDF-",
      "body does not start with PDF magic bytes",
    );
  } finally {
    await handle.close();
  }
});

test("GET /api/trust/summary.pdf requires authentication", async () => {
  const handle = await startServer();
  try {
    const res = await fetch(
      `http://127.0.0.1:${handle.port}/api/trust/summary.pdf`,
    );
    assert.equal(
      res.status,
      401,
      `expected 401 for unauth, got ${res.status}`,
    );
  } finally {
    await handle.close();
  }
});
