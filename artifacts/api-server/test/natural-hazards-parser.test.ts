/**
 * Natural-hazards parser tests covering all four sub-feeds:
 *   USGS earthquakes, NOAA NWS alerts, NASA EONET events, GDACS RSS.
 *
 * Pins the contract that:
 *   - each parser tags the right HAZARD_SOURCE_CODES.* in `value`
 *   - every draft has signalType=natural_hazard with eventId in metadata
 *   - schema validation passes
 *   - stable keys are unique across mixed-source draft sets (id collisions
 *     between feeds are prevented by the `value` (source code) being
 *     part of the dedupe shape)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseUsgsFeed,
  parseNwsAlerts,
  parseEonetEvents,
  parseGdacsRss,
  gdacsItemToDraft,
  HAZARD_SOURCE_CODES,
  NWS_SEVERITY_VALUES,
  GDACS_ALERT_VALUES,
  naturalHazardsCollector,
  type UsgsFeed,
  type NwsAlertsResponse,
  type EonetResponse,
} from "../src/lib/intelligence/collectors/natural-hazards";

const USGS: UsgsFeed = {
  features: [
    {
      id: "us6000abcd",
      properties: {
        mag: 5.4,
        place: "20 km E of Tegucigalpa, Honduras",
        time: Date.UTC(2026, 3, 30, 8, 0, 0),
        url: "https://earthquake.usgs.gov/earthquakes/eventpage/us6000abcd",
        type: "earthquake",
        tsunami: 0,
      },
      geometry: { coordinates: [-87.0, 14.0, 35] },
    },
    {
      id: "us6000efgh",
      properties: {
        mag: 6.1,
        place: "South of the Fiji Islands",
        time: Date.UTC(2026, 3, 30, 9, 0, 0),
      },
      geometry: { coordinates: [178.0, -22.0, 600] },
    },
    {
      // No mag → skip
      id: "us6000xxxx",
      properties: { place: "?", time: Date.UTC(2026, 3, 30) },
    },
  ],
};

describe("parseUsgsFeed", () => {
  it("emits one draft per quake with mag/time and source code = USGS", () => {
    const drafts = parseUsgsFeed(USGS);
    assert.equal(drafts.length, 2);
    assert.equal(drafts[0]!.value, HAZARD_SOURCE_CODES.USGS);
    assert.equal(drafts[0]!.scopeLaneKey, "Honduras");
    assert.equal(drafts[1]!.scopeLaneKey, "South of the Fiji Islands");
    const meta = drafts[0]!.metadata as Record<string, unknown>;
    assert.equal(meta["sourceName"], "USGS");
    assert.equal(meta["magnitude"], 5.4);
    assert.equal(meta["latitude"], 14.0);
    assert.equal(meta["longitude"], -87.0);
  });
});

const NWS: NwsAlertsResponse = {
  features: [
    {
      id: "https://api.weather.gov/alerts/urn:oid:abc",
      properties: {
        id: "urn:oid:abc",
        event: "Tornado Warning",
        severity: "Severe",
        certainty: "Observed",
        urgency: "Immediate",
        sent: "2026-04-30T08:30:00Z",
        areaDesc: "Cook, IL",
        headline: "Tornado in Cook County",
        messageType: "Alert",
      },
    },
    {
      id: "https://api.weather.gov/alerts/urn:oid:def",
      properties: {
        id: "urn:oid:def",
        event: "Heat Advisory",
        severity: "Moderate",
        sent: "2026-04-30T09:00:00Z",
      },
    },
  ],
};

describe("parseNwsAlerts", () => {
  it("emits one draft per alert with US lane + severity mapped", () => {
    const drafts = parseNwsAlerts(NWS);
    assert.equal(drafts.length, 2);
    for (const d of drafts) {
      assert.equal(d.value, HAZARD_SOURCE_CODES.NWS);
      assert.equal(d.scopeLaneKey, "US");
    }
    const meta0 = drafts[0]!.metadata as Record<string, unknown>;
    assert.equal(meta0["severityValue"], NWS_SEVERITY_VALUES["Severe"]);
    const meta1 = drafts[1]!.metadata as Record<string, unknown>;
    assert.equal(meta1["severityValue"], NWS_SEVERITY_VALUES["Moderate"]);
  });
});

const EONET: EonetResponse = {
  events: [
    {
      id: "EONET_6789",
      title: "Wildfires - Northern California",
      closed: null,
      categories: [{ id: "wildfires", title: "Wildfires" }],
      sources: [{ id: "InciWeb", url: "https://inciweb.nwcg.gov/incident/12345/" }],
      geometry: [
        { date: "2026-04-25T00:00:00Z", coordinates: [-122.0, 39.0], magnitudeValue: 1500, magnitudeUnit: "acres" },
        { date: "2026-04-29T00:00:00Z", coordinates: [-122.1, 39.1], magnitudeValue: 2500, magnitudeUnit: "acres" },
      ],
    },
  ],
};

describe("parseEonetEvents", () => {
  it("uses the latest geometry for observedAt and emits source EONET", () => {
    const drafts = parseEonetEvents(EONET);
    assert.equal(drafts.length, 1);
    const d = drafts[0]!;
    assert.equal(d.value, HAZARD_SOURCE_CODES.EONET);
    assert.equal(d.observedAt.toISOString(), "2026-04-29T00:00:00.000Z");
    const meta = d.metadata as Record<string, unknown>;
    assert.equal(meta["magnitudeValue"], 2500);
    assert.equal(meta["latitude"], 39.1);
    assert.equal(meta["longitude"], -122.1);
  });
});

const GDACS_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:gdacs="http://www.gdacs.org">
  <channel>
    <item>
      <title>Orange alert for Tropical Cyclone in Mauritius</title>
      <link>https://www.gdacs.org/report.aspx?eventid=1000123&amp;eventtype=TC</link>
      <guid>TC1000123</guid>
      <pubDate>Wed, 30 Apr 2026 06:00:00 GMT</pubDate>
      <gdacs:alertlevel>Orange</gdacs:alertlevel>
      <gdacs:country>Mauritius</gdacs:country>
      <gdacs:eventtype>TC</gdacs:eventtype>
    </item>
    <item>
      <title>Green alert for Earthquake in Chile</title>
      <link>https://www.gdacs.org/report.aspx?eventid=1000124&amp;eventtype=EQ</link>
      <guid>EQ1000124</guid>
      <pubDate>Wed, 30 Apr 2026 07:00:00 GMT</pubDate>
      <gdacs:alertlevel><![CDATA[Green]]></gdacs:alertlevel>
      <gdacs:country>Chile</gdacs:country>
      <gdacs:eventtype>EQ</gdacs:eventtype>
    </item>
  </channel>
</rss>`;

describe("parseGdacsRss + gdacsItemToDraft", () => {
  it("parses each <item> with namespaced gdacs tags and CDATA", () => {
    const items = parseGdacsRss(GDACS_RSS);
    assert.equal(items.length, 2);
    assert.equal(items[0]!.id, "TC1000123");
    assert.equal(items[0]!.alertLevel, "Orange");
    assert.equal(items[1]!.alertLevel, "Green");
    assert.equal(items[1]!.country, "Chile");
  });

  it("converts items to drafts with value=GDACS source code and alert mapped", () => {
    const drafts = parseGdacsRss(GDACS_RSS).map(gdacsItemToDraft);
    for (const d of drafts) {
      assert.equal(d.value, HAZARD_SOURCE_CODES.GDACS);
    }
    const m0 = drafts[0]!.metadata as Record<string, unknown>;
    assert.equal(m0["alertValue"], GDACS_ALERT_VALUES["Orange"]);
    const m1 = drafts[1]!.metadata as Record<string, unknown>;
    assert.equal(m1["alertValue"], GDACS_ALERT_VALUES["Green"]);
  });
});

describe("naturalHazardsCollector schema + key", () => {
  it("schema accepts drafts from all four sub-feeds", () => {
    const all = [
      ...parseUsgsFeed(USGS),
      ...parseNwsAlerts(NWS),
      ...parseEonetEvents(EONET),
      ...parseGdacsRss(GDACS_RSS).map(gdacsItemToDraft),
    ];
    for (const d of all) {
      const r = naturalHazardsCollector.signalSchema.safeParse(d);
      assert.ok(r.success, JSON.stringify(r));
    }
  });

  it("stable signal keys are unique across the mixed-source set", () => {
    const all = [
      ...parseUsgsFeed(USGS),
      ...parseNwsAlerts(NWS),
      ...parseEonetEvents(EONET),
      ...parseGdacsRss(GDACS_RSS).map(gdacsItemToDraft),
    ];
    const keys = all.map(naturalHazardsCollector.stableSignalKey);
    assert.equal(new Set(keys).size, keys.length);
  });
});
