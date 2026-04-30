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
import { parseEcbDailyFeed } from "../src/lib/intelligence/collectors/ecb-fx-rates";

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
