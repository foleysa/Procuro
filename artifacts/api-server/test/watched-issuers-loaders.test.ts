/**
 * Unit tests for the issuer-list dedupe / normalisation helpers used by
 * the SEC EDGAR and Companies House collectors.
 *
 * These cover the pure parts (`dedupeSecIssuers`,
 * `normaliseCompaniesHouseNumber`) so the contract that "two tenants
 * watching the same identifier cost us only one upstream fetch" is
 * pinned without needing a live DB. The async loaders
 * (`loadWatchedSecIssuers`, `loadWatchedCompaniesHouseNumbers`) are
 * exercised separately by the integration test.
 */
import test from "node:test";
import assert from "node:assert/strict";

if (!process.env["DATABASE_URL"]) {
  // Same trick as collectors-validation.test.ts: a placeholder URL so
  // the import-time guard in `@workspace/db` is satisfied. These pure
  // helpers never touch the pool.
  process.env["DATABASE_URL"] = "postgres://test:test@127.0.0.1:5432/test";
}

const {
  dedupeSecIssuers,
  padCik,
  logResolvedSecIssuers,
  _resetSecIssuerSourceMemoryForTests,
} = await import("../src/lib/intelligence/collectors/sec-edgar");
const {
  normaliseCompaniesHouseNumber,
  logResolvedCompaniesHouseNumbers,
  _resetCompaniesHouseSourceMemoryForTests,
} = await import("../src/lib/intelligence/collectors/companies-house");
const { logger } = await import("../src/lib/logger");

interface CapturedLog {
  level: "info" | "warn";
  obj: Record<string, unknown>;
  msg: string;
}

/**
 * Monkey-patch the shared `logger` for the duration of `fn` and
 * collect every info/warn call made through it. We deliberately
 * patch the singleton (rather than wiring a custom destination)
 * because the collector code imports `{ logger }` directly and
 * pino transports happen out-of-process in dev.
 */
async function captureLogs<T>(
  fn: (logs: CapturedLog[]) => T | Promise<T>,
): Promise<{ logs: CapturedLog[]; result: T }> {
  const logs: CapturedLog[] = [];
  const originalInfo = logger.info.bind(logger);
  const originalWarn = logger.warn.bind(logger);
  (logger as unknown as { info: unknown }).info = (
    obj: Record<string, unknown>,
    msg?: string,
  ) => logs.push({ level: "info", obj: obj ?? {}, msg: msg ?? "" });
  (logger as unknown as { warn: unknown }).warn = (
    obj: Record<string, unknown>,
    msg?: string,
  ) => logs.push({ level: "warn", obj: obj ?? {}, msg: msg ?? "" });
  try {
    const result = await fn(logs);
    return { logs, result };
  } finally {
    (logger as unknown as { info: unknown }).info = originalInfo;
    (logger as unknown as { warn: unknown }).warn = originalWarn;
  }
}

test("dedupeSecIssuers de-dupes on padded CIK and keeps first occurrence", () => {
  const out = dedupeSecIssuers([
    { cik: "320193", name: "Apple Inc.", lei: "HWUPKR0MPOU8FGXBT394" },
    // Same issuer, alternate (zero-padded) shape. Should be dropped.
    { cik: "0000320193", name: "Apple (alias)" },
    { cik: "789019", name: "Microsoft Corporation" },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0]!.name, "Apple Inc.");
  // First-occurrence wins so enrichment (LEI on the first row) is preserved.
  assert.equal(out[0]!.lei, "HWUPKR0MPOU8FGXBT394");
  assert.equal(out[1]!.name, "Microsoft Corporation");
});

test("dedupeSecIssuers drops issuers whose CIK normalises to empty", () => {
  const out = dedupeSecIssuers([
    { cik: "", name: "Empty" },
    { cik: "non-numeric", name: "Garbage" },
    { cik: "320193", name: "Apple Inc." },
  ]);
  // padCik("non-numeric") → "0000000000" — that's a valid 10-digit
  // string but represents CIK 0, which EDGAR will reject. We DO NOT
  // drop it here on purpose: validation belongs at the admin route.
  // The empty input on the other hand has nothing to pad and is
  // dropped (`!key`).
  const ciks = out.map((i) => padCik(i.cik));
  assert.ok(ciks.includes("0000320193"));
  assert.equal(ciks.includes(""), false);
});

test("normaliseCompaniesHouseNumber zero-pads numeric inputs to 8 chars", () => {
  assert.equal(normaliseCompaniesHouseNumber("6245"), "00006245");
  assert.equal(normaliseCompaniesHouseNumber("00006245"), "00006245");
  assert.equal(normaliseCompaniesHouseNumber("  6245  "), "00006245");
  // Leaves alpha-prefixed Scottish/NI numbers alone (they're already
  // canonical and zero-padding would corrupt the prefix).
  assert.equal(normaliseCompaniesHouseNumber("SC123456"), "SC123456");
  assert.equal(normaliseCompaniesHouseNumber("ni000005"), "NI000005");
});

test("logResolvedSecIssuers emits one INFO line per tick with source + count", async () => {
  _resetSecIssuerSourceMemoryForTests();
  const { logs } = await captureLogs(() => {
    logResolvedSecIssuers(
      {
        source: "seed",
        issuers: [
          { cik: "0000320193", name: "Apple Inc." },
          { cik: "0000789019", name: "Microsoft" },
        ],
      },
      "collect",
    );
  });
  // Exactly one INFO, no transition WARN on the first tick.
  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.level, "info");
  assert.equal(logs[0]!.obj["collectorId"], "sec-edgar");
  assert.equal(logs[0]!.obj["listSource"], "seed");
  assert.equal(logs[0]!.obj["issuerCount"], 2);
  assert.equal(logs[0]!.obj["callSite"], "collect");
  assert.match(logs[0]!.msg, /polling 2 issuer\(s\) \(source=seed\)/);
});

test("logResolvedSecIssuers emits a one-shot WARN on seed → tenant transition", async () => {
  _resetSecIssuerSourceMemoryForTests();
  const { logs } = await captureLogs(() => {
    logResolvedSecIssuers(
      { source: "seed", issuers: [{ cik: "0000320193", name: "Apple" }] },
      "collect",
    );
    logResolvedSecIssuers(
      {
        source: "tenant",
        issuers: [
          { cik: "0000320193", name: "Apple" },
          { cik: "0000018230", name: "Caterpillar" },
        ],
      },
      "collect",
    );
    // Stable second tick at "tenant" — must NOT re-warn.
    logResolvedSecIssuers(
      { source: "tenant", issuers: [{ cik: "0000320193", name: "Apple" }] },
      "collect",
    );
  });
  const warns = logs.filter((l) => l.level === "warn");
  assert.equal(warns.length, 1, "exactly one transition WARN expected");
  assert.equal(warns[0]!.obj["previousSource"], "seed");
  assert.equal(warns[0]!.obj["listSource"], "tenant");
  assert.match(warns[0]!.msg, /seed → tenant/);
  // Three INFO lines (one per tick) regardless of warn behaviour.
  assert.equal(logs.filter((l) => l.level === "info").length, 3);
});

test("logResolvedSecIssuers tracks call sites independently", async () => {
  _resetSecIssuerSourceMemoryForTests();
  const { logs } = await captureLogs(() => {
    // collect is at seed
    logResolvedSecIssuers({ source: "seed", issuers: [] }, "collect");
    // backfill arrives at "override" — must NOT trigger a transition
    // warn for collect; backfill's own first tick has no prior state.
    logResolvedSecIssuers(
      { source: "override", issuers: [{ cik: "0000320193", name: "Apple" }] },
      "backfill",
    );
  });
  assert.equal(logs.filter((l) => l.level === "warn").length, 0);
});

test("logResolvedCompaniesHouseNumbers emits INFO + transition WARN on source change", async () => {
  _resetCompaniesHouseSourceMemoryForTests();
  const { logs } = await captureLogs(() => {
    logResolvedCompaniesHouseNumbers(
      { source: "seed", numbers: ["00006245"] },
      "collect",
    );
    logResolvedCompaniesHouseNumbers(
      { source: "tenant", numbers: ["00006245", "02099500"] },
      "collect",
    );
  });
  const infos = logs.filter((l) => l.level === "info");
  const warns = logs.filter((l) => l.level === "warn");
  assert.equal(infos.length, 2);
  assert.equal(infos[0]!.obj["collectorId"], "companies-house");
  assert.equal(infos[0]!.obj["listSource"], "seed");
  assert.equal(infos[0]!.obj["numberCount"], 1);
  assert.equal(infos[1]!.obj["listSource"], "tenant");
  assert.equal(infos[1]!.obj["numberCount"], 2);
  assert.equal(warns.length, 1);
  assert.equal(warns[0]!.obj["previousSource"], "seed");
  assert.equal(warns[0]!.obj["listSource"], "tenant");
  assert.match(warns[0]!.msg, /seed → tenant/);
});
