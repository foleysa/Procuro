#!/usr/bin/env node
/**
 * Post-codegen patcher.
 *
 * orval (v8.x) emits `body: JSON.stringify(...)` for every operation,
 * including ones whose request body is `multipart/form-data` or a raw
 * binary stream. For the `ingestCsvStream` endpoint this would silently
 * serialize a Blob/File to "{}" and produce zero-row uploads.
 *
 * This script rewrites the generated `ingestCsvStream` function in
 * `lib/api-client-react/src/generated/api.ts` so that it:
 *   - sends a `Blob` directly with `Content-Type: text/csv`, OR
 *   - sends a `{ file }` object as `multipart/form-data` (the browser
 *     fills in the boundary automatically).
 *
 * Both transports are accepted by the server route. Run automatically
 * from the `codegen` npm script after orval finishes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiTs = path.resolve(
  here,
  "..",
  "..",
  "api-client-react",
  "src",
  "generated",
  "api.ts",
);

let src = readFileSync(apiTs, "utf8");

const original = `export const ingestCsvStream = async (
  ingestCsvStreamBody: IngestCsvStreamBodyOne | Blob,
  params: IngestCsvStreamParams,
  options?: RequestInit,
): Promise<StreamCsvResult> => {
  return customFetch<StreamCsvResult>(getIngestCsvStreamUrl(params), {
    ...options,
    method: "POST",
    body: JSON.stringify(ingestCsvStreamBody),
  });
};`;

const patched = `export const ingestCsvStream = async (
  ingestCsvStreamBody: IngestCsvStreamBodyOne | Blob,
  params: IngestCsvStreamParams,
  options?: RequestInit,
): Promise<StreamCsvResult> => {
  // Patched by lib/api-spec/scripts/patch-codegen.mjs.
  // orval emits \`JSON.stringify\` for binary/multipart bodies, which would
  // serialize a Blob/File to "{}" and silently upload an empty file. We
  // instead pick the right BodyInit based on the input shape, matching the
  // two transports the server route supports (multipart/form-data with a
  // \`file\` part, or a raw \`text/csv\` body).
  let body: BodyInit;
  let inferredContentType: string | undefined;
  if (typeof Blob !== "undefined" && ingestCsvStreamBody instanceof Blob) {
    body = ingestCsvStreamBody;
    inferredContentType = "text/csv";
  } else {
    const fd = new FormData();
    fd.append("file", (ingestCsvStreamBody as IngestCsvStreamBodyOne).file);
    body = fd;
    // Intentionally leave Content-Type unset — the browser/runtime sets
    // \`multipart/form-data; boundary=...\` automatically.
  }

  const headers = new Headers((options as RequestInit | undefined)?.headers);
  if (inferredContentType && !headers.has("content-type")) {
    headers.set("content-type", inferredContentType);
  }

  return customFetch<StreamCsvResult>(getIngestCsvStreamUrl(params), {
    ...options,
    method: "POST",
    headers,
    body,
  });
};`;

if (src.includes(patched)) {
  console.log("patch-codegen: ingestCsvStream already patched, skipping.");
  process.exit(0);
}

if (!src.includes(original)) {
  console.error(
    "patch-codegen: could not find the expected ingestCsvStream body in",
    apiTs,
  );
  console.error(
    "patch-codegen: orval output may have changed — update scripts/patch-codegen.mjs.",
  );
  process.exit(1);
}

src = src.replace(original, patched);
writeFileSync(apiTs, src);
console.log("patch-codegen: patched ingestCsvStream in", apiTs);
