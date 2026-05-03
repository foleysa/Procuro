/**
 * GDELT 2.0 events parser tests.
 *
 * Pins the contract that:
 *   - lastupdate.txt is parsed for the events bundle URL
 *   - tab-separated event rows produce drafts with the right fields
 *   - DATEADDED parses as UTC
 *   - cap is honoured
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseLastUpdateForEventsUrl,
  parseGdeltEvents,
  GDELT_EVENT_COLS,
  GDELT_MAX_EVENTS_PER_RUN,
  gdeltEventsCollector,
} from "../src/lib/intelligence/collectors/gdelt-events";

describe("parseLastUpdateForEventsUrl", () => {
  it("returns the events URL (line containing .export.CSV), upgraded to https", () => {
    // GDELT's lastupdate.txt embeds http:// links. The parser must
    // upgrade them to https so the subsequent fetch is not downgraded
    // (#320 — security baseline finding from #309 CI/CD scanning).
    const body =
      "139534 38918 http://data.gdeltproject.org/gdeltv2/20260430000000.export.CSV.zip\n" +
      "234443 12300 http://data.gdeltproject.org/gdeltv2/20260430000000.mentions.CSV.zip\n" +
      "98000 9000 http://data.gdeltproject.org/gdeltv2/20260430000000.gkg.csv.zip\n";
    assert.equal(
      parseLastUpdateForEventsUrl(body),
      "https://data.gdeltproject.org/gdeltv2/20260430000000.export.CSV.zip",
    );
  });

  it("leaves an https URL unchanged", () => {
    const body =
      "139534 38918 https://data.gdeltproject.org/gdeltv2/20260430000000.export.CSV.zip\n";
    assert.equal(
      parseLastUpdateForEventsUrl(body),
      "https://data.gdeltproject.org/gdeltv2/20260430000000.export.CSV.zip",
    );
  });

  it("returns null when no events line is present", () => {
    assert.equal(parseLastUpdateForEventsUrl("\n\n"), null);
  });
});

function buildRow(overrides: Record<number, string> = {}): string {
  const cols = new Array<string>(GDELT_EVENT_COLS.SOURCEURL + 1).fill("");
  cols[GDELT_EVENT_COLS.GLOBALEVENTID] = "1234567890";
  cols[GDELT_EVENT_COLS.SQLDATE] = "20260430";
  cols[GDELT_EVENT_COLS.Actor1Name] = "USA";
  cols[GDELT_EVENT_COLS.Actor1CountryCode] = "USA";
  cols[GDELT_EVENT_COLS.Actor2Name] = "CHN";
  cols[GDELT_EVENT_COLS.Actor2CountryCode] = "CHN";
  cols[GDELT_EVENT_COLS.EventCode] = "043";
  cols[GDELT_EVENT_COLS.GoldsteinScale] = "1.9";
  cols[GDELT_EVENT_COLS.NumMentions] = "5";
  cols[GDELT_EVENT_COLS.AvgTone] = "-2.5";
  cols[GDELT_EVENT_COLS.ActionGeo_FullName] = "Beijing, China";
  cols[GDELT_EVENT_COLS.ActionGeo_CountryCode] = "CH";
  cols[GDELT_EVENT_COLS.ActionGeo_Lat] = "39.9";
  cols[GDELT_EVENT_COLS.ActionGeo_Long] = "116.4";
  cols[GDELT_EVENT_COLS.DATEADDED] = "20260430120000";
  cols[GDELT_EVENT_COLS.SOURCEURL] = "https://example.com/article";
  for (const [idx, val] of Object.entries(overrides)) {
    cols[Number(idx)] = val;
  }
  return cols.join("\t");
}

describe("parseGdeltEvents", () => {
  it("emits one draft per valid row with the right shape", () => {
    const csv = [buildRow(), buildRow({ [GDELT_EVENT_COLS.GLOBALEVENTID]: "999" })].join("\n");
    const drafts = parseGdeltEvents(csv, "http://data.gdeltproject.org/x.csv");
    assert.equal(drafts.length, 2);
    const d = drafts[0]!;
    assert.equal(d.signalType, "event_geocoded");
    assert.equal(d.value, 43);
    assert.equal(d.scopeSku, "1234567890");
    assert.equal(d.scopeLaneKey, "CH");
    assert.equal(d.scopeSupplierName, "USA");
    assert.equal(d.observedAt.toISOString(), "2026-04-30T12:00:00.000Z");
    const meta = d.metadata as Record<string, unknown>;
    assert.equal(meta["actionGeoLat"], 39.9);
    assert.equal(meta["actionGeoLong"], 116.4);
    assert.equal(meta["goldsteinScale"], 1.9);
  });

  it("skips rows with bad event id, missing DATEADDED, or non-numeric event code", () => {
    const lines = [
      buildRow({ [GDELT_EVENT_COLS.GLOBALEVENTID]: "" }),
      buildRow({ [GDELT_EVENT_COLS.DATEADDED]: "" }),
      buildRow({ [GDELT_EVENT_COLS.EventCode]: "abc" }),
      buildRow({ [GDELT_EVENT_COLS.DATEADDED]: "not-a-date" }),
    ].join("\n");
    assert.equal(parseGdeltEvents(lines, "x").length, 0);
  });

  it("respects GDELT_MAX_EVENTS_PER_RUN cap", () => {
    const rows = Array.from({ length: GDELT_MAX_EVENTS_PER_RUN + 50 }, (_, i) =>
      buildRow({ [GDELT_EVENT_COLS.GLOBALEVENTID]: String(i + 1) }),
    );
    const csv = rows.join("\n");
    const drafts = parseGdeltEvents(csv, "x");
    assert.equal(drafts.length, GDELT_MAX_EVENTS_PER_RUN);
  });

  it("parser output passes the collector's signal schema", () => {
    const csv = buildRow();
    const drafts = parseGdeltEvents(csv, "x");
    for (const d of drafts) {
      const r = gdeltEventsCollector.signalSchema.safeParse(d);
      assert.ok(r.success, JSON.stringify(r));
    }
  });

  it("stable keys are unique per row and idempotent across re-parses", () => {
    const csv = [
      buildRow({ [GDELT_EVENT_COLS.GLOBALEVENTID]: "100" }),
      buildRow({ [GDELT_EVENT_COLS.GLOBALEVENTID]: "200" }),
    ].join("\n");
    const a = parseGdeltEvents(csv, "x").map(gdeltEventsCollector.stableSignalKey);
    const b = parseGdeltEvents(csv, "x").map(gdeltEventsCollector.stableSignalKey);
    assert.deepEqual(a, b);
    assert.equal(new Set(a).size, 2);
  });
});
