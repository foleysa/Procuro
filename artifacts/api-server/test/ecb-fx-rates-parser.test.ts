/**
 * Unit test for the ECB daily reference-rates XML parser.
 *
 * The parser is deliberately narrow (a focused regex over the well-known,
 * extremely stable ECB schema) so that we don't pull an XML dependency in
 * for one feed. This test pins:
 *
 *   - the published date is extracted from the inner `<Cube time="...">`
 *   - every `<Cube currency=X rate=R/>` row is captured
 *   - rates are parsed as numbers (not strings)
 *   - malformed feeds raise a clear error
 *
 * If the ECB ever swaps attribute order or changes quoting style this test
 * will fail loudly here rather than silently emitting zero signals.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseEcbDailyFeed,
  parseEcbHistoricalFeed,
  buildEcbBackfillDrafts,
} from "../src/lib/intelligence/collectors/ecb-fx-rates";

const SAMPLE_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <gesmes:subject>Reference rates</gesmes:subject>
  <gesmes:Sender>
    <gesmes:name>European Central Bank</gesmes:name>
  </gesmes:Sender>
  <Cube>
    <Cube time='2026-04-29'>
      <Cube currency='USD' rate='1.0823'/>
      <Cube currency='JPY' rate='159.42'/>
      <Cube currency='GBP' rate='0.85630'/>
      <Cube currency='CHF' rate='0.9512'/>
      <Cube currency='SEK' rate='11.4500'/>
    </Cube>
  </Cube>
</gesmes:Envelope>`;

describe("parseEcbDailyFeed", () => {
  it("extracts the published date and all currency rates", () => {
    const feed = parseEcbDailyFeed(SAMPLE_FEED);
    assert.equal(feed.date, "2026-04-29");
    assert.equal(feed.rates["USD"], 1.0823);
    assert.equal(feed.rates["JPY"], 159.42);
    assert.equal(feed.rates["GBP"], 0.8563);
    assert.equal(feed.rates["CHF"], 0.9512);
    assert.equal(feed.rates["SEK"], 11.45);
  });

  it("supports the cross-rate math used to derive USD-base pairs", () => {
    const feed = parseEcbDailyFeed(SAMPLE_FEED);
    // USD/JPY = JPY-per-EUR / USD-per-EUR
    const usdJpy = feed.rates["JPY"]! / feed.rates["USD"]!;
    assert.ok(Math.abs(usdJpy - 147.297422) < 1e-3, `USD/JPY=${usdJpy}`);
  });

  it("also accepts double-quoted attributes (no assumption on quote style)", () => {
    const xml = `<Cube time="2026-04-30"><Cube currency="USD" rate="1.10"/></Cube>`;
    const feed = parseEcbDailyFeed(xml);
    assert.equal(feed.date, "2026-04-30");
    assert.equal(feed.rates["USD"], 1.1);
  });

  it("throws when no time attribute is present", () => {
    assert.throws(() => parseEcbDailyFeed("<Cube></Cube>"), /missing time/);
  });

  it("throws when no rate rows can be parsed", () => {
    assert.throws(
      () => parseEcbDailyFeed(`<Cube time="2026-04-30"></Cube>`),
      /no rates parsed/,
    );
  });
});

const SAMPLE_HISTORICAL_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <gesmes:subject>Reference rates</gesmes:subject>
  <Cube>
    <Cube time='2026-04-29'>
      <Cube currency='USD' rate='1.0823'/>
      <Cube currency='GBP' rate='0.8563'/>
      <Cube currency='JPY' rate='159.42'/>
    </Cube>
    <Cube time='2026-04-28'>
      <Cube currency='USD' rate='1.0810'/>
      <Cube currency='GBP' rate='0.8550'/>
      <Cube currency='JPY' rate='158.10'/>
    </Cube>
    <Cube time='2026-04-25'>
      <Cube currency='USD' rate='1.0790'/>
      <Cube currency='GBP' rate='0.8540'/>
    </Cube>
  </Cube>
</gesmes:Envelope>`;

describe("parseEcbHistoricalFeed", () => {
  it("returns one EcbFeed per <Cube time=...> day-block", () => {
    const days = parseEcbHistoricalFeed(SAMPLE_HISTORICAL_FEED);
    assert.equal(days.length, 3);
    assert.deepEqual(
      days.map((d) => d.date),
      ["2026-04-29", "2026-04-28", "2026-04-25"],
    );
  });

  it("parses rates per day independently", () => {
    const days = parseEcbHistoricalFeed(SAMPLE_HISTORICAL_FEED);
    assert.equal(days[0]!.rates["USD"], 1.0823);
    assert.equal(days[1]!.rates["USD"], 1.081);
    assert.equal(days[2]!.rates["USD"], 1.079);
    // Day 3 omitted JPY — must not bleed across days.
    assert.equal(days[2]!.rates["JPY"], undefined);
  });

  it("throws when the archive contains no day blocks", () => {
    assert.throws(
      () => parseEcbHistoricalFeed("<Envelope><Cube></Cube></Envelope>"),
      /no day blocks parsed/,
    );
  });
});

describe("buildEcbBackfillDrafts", () => {
  it("emits EUR-base + USD-derived drafts per day with deterministic observedAt", () => {
    const days = parseEcbHistoricalFeed(SAMPLE_HISTORICAL_FEED);
    const drafts = buildEcbBackfillDrafts(days);

    // Tracked EUR-base quotes that appear in the sample:
    //   day1: USD, GBP, JPY → 3   day2: USD, GBP, JPY → 3   day3: USD, GBP → 2
    // Tracked USD-derived (excludes USD itself):
    //   day1: GBP, JPY → 2        day2: GBP, JPY → 2        day3: GBP → 1
    // Total: 8 EUR-base + 5 USD-derived = 13
    assert.equal(drafts.length, 13);

    // observedAt is anchored to 15:00 UTC on the published date.
    const day1Drafts = drafts.filter(
      (d) => d.observedAt.toISOString() === "2026-04-29T15:00:00.000Z",
    );
    assert.ok(day1Drafts.length > 0, "day1 drafts present");

    // Every draft is an fx_rate signal pointing at a recognizable pair.
    for (const d of drafts) {
      assert.equal(d.signalType, "fx_rate");
      assert.match(d.scopeMaterialCode ?? "", /^(EUR|USD)\/[A-Z]{3}$/);
      assert.equal(d.metadata?.["feed"], "ecb-eurofxref-hist");
    }
  });

  it("backfill drafts share the same (scope, observedAt) key as live drafts so dedupe works", () => {
    // Single-day historical doc — the (pair, observedAt) keys we produce must
    // match what the live collector would have written for the same day.
    const histXml = `<Cube>
      <Cube time='2026-04-29'>
        <Cube currency='USD' rate='1.0823'/>
        <Cube currency='GBP' rate='0.8563'/>
      </Cube>
    </Cube>`;
    const dailyXml = `<Cube time='2026-04-29'>
      <Cube currency='USD' rate='1.0823'/>
      <Cube currency='GBP' rate='0.8563'/>
    </Cube>`;

    const histDrafts = buildEcbBackfillDrafts(parseEcbHistoricalFeed(histXml));
    const dailyFeed = parseEcbDailyFeed(dailyXml);

    // The dedupe key the runtime uses is `${scopeMaterialCode}@${observedAt.toISOString()}`.
    const keys = histDrafts.map(
      (d) => `${d.scopeMaterialCode}@${d.observedAt.toISOString()}`,
    );
    // The same date+pair should produce the same key whether the row came in
    // via the live collector or the backfill — so re-running the backfill
    // after the live collector ran today is a no-op.
    const expectedObserved = `2026-04-29T15:00:00.000Z`;
    assert.ok(keys.includes(`EUR/USD@${expectedObserved}`));
    assert.ok(keys.includes(`EUR/GBP@${expectedObserved}`));
    assert.ok(keys.includes(`USD/GBP@${expectedObserved}`));
    // sanity — daily parser saw the same date.
    assert.equal(dailyFeed.date, "2026-04-29");
  });
});
