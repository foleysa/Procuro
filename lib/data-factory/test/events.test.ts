import { describe, expect, it } from "vitest";
import { NEWS_OSINT_SOURCE_IDS } from "../src/catalog";
import {
  OSINT_FORBIDDEN_PAYLOAD_KEYS,
  OSINT_TOS,
  canonicalizeEventUrl,
  dedupeEvents,
  eventHasForbiddenPayloadKeys,
  ingestRssItems,
  newsOsintMetadataStream,
  normalizeRssItem,
  toPulseCitedBullets,
} from "../src/events";
import { fetchNewsOsintSources } from "../src/fetch-stubs";
import { packageNewsOsintStream } from "../src/packages";
import { getLayerAObservationSchema } from "../src/schemas";

describe("news/OSINT event pipeline", () => {
  it("normalizes RSS metadata and drops article HTML / body fields", () => {
    const event = normalizeRssItem({
      sourceId: "src_freightwaves_rss",
      title: "  Port delay at LA  ",
      link: "https://www.freightwaves.com/news/port-delay?utm_source=rss",
      pubDate: "Wed, 16 Sep 2026 08:00:00 GMT",
      description: "<p>Full article teaser</p>",
      content: "<article>Do not store</article>",
      contentEncoded: "<html><body>Nope</body></html>",
      htmlBody: "<div>secret</div>",
      fullText: "The entire article text…",
    });
    expect(event).not.toBeNull();
    expect(event?.title).toBe("Port delay at LA");
    expect(event?.url).toBe("https://www.freightwaves.com/news/port-delay");
    expect(event?.source).toBe("src_freightwaves_rss");
    expect(event?.event_type).toBe("freight");
    expect(event?.severity).toBe("unknown");
    expect(event?.entities).toEqual([]);
    expect(eventHasForbiddenPayloadKeys(event!)).toBe(false);
    for (const key of OSINT_FORBIDDEN_PAYLOAD_KEYS) {
      expect(event).not.toHaveProperty(key);
    }
  });

  it("dedupes by canonical URL", () => {
    const events = ingestRssItems([
      {
        sourceId: "src_gcaptain",
        title: "Canal restriction",
        link: "https://gcaptain.com/canal/?utm_medium=rss",
      },
      {
        sourceId: "src_gcaptain",
        title: "Canal restriction (updated)",
        link: "https://gcaptain.com/canal/",
      },
      {
        sourceId: "src_splash247",
        title: "Different story",
        link: "https://splash247.com/other/",
      },
    ]);
    expect(events).toHaveLength(2);
    expect(events[0]?.url).toBe("https://gcaptain.com/canal/");
  });

  it("rejects items without a title or http(s) link", () => {
    expect(
      normalizeRssItem({ sourceId: "src_bbc_business", title: "x" }),
    ).toBeNull();
    expect(
      normalizeRssItem({
        sourceId: "src_bbc_business",
        link: "https://www.bbc.com/news/1",
      }),
    ).toBeNull();
    expect(canonicalizeEventUrl("javascript:alert(1)")).toBeNull();
  });

  it("packages Pulse as cited bullets with links", () => {
    const bullets = toPulseCitedBullets([
      {
        title: "NHC advisory",
        url: "https://www.nhc.noaa.gov/text/MIATCPAT1.shtml",
        published: "2026-09-16T00:00:00.000Z",
        source: "src_nhc_products",
        entities: ["Atlantic"],
        event_type: "storm",
        severity: "watch",
      },
    ]);
    expect(bullets).toEqual([
      {
        text: "NHC advisory",
        url: "https://www.nhc.noaa.gov/text/MIATCPAT1.shtml",
        source: "src_nhc_products",
        published: "2026-09-16T00:00:00.000Z",
      },
    ]);
  });

  it("exposes an empty metadata stream with ToS fences", () => {
    const stream = newsOsintMetadataStream([]);
    expect(stream.ga).toBe(false);
    expect(stream.track).toBe("news_osint");
    expect(stream.events).toEqual([]);
    expect(stream.pulse.citedBullets).toEqual([]);
    expect(stream.tos).toEqual(OSINT_TOS);
    expect(stream.tos.headlinesAndLink).toBe("ok");
    expect(stream.tos.fullTextRepublish).toBe("out_of_scope");
    expect(stream.tos.storesFullArticleHtml).toBe(false);
    expect(stream.sources.map((s) => s.id)).toEqual([...NEWS_OSINT_SOURCE_IDS]);
    expect(packageNewsOsintStream().events).toEqual([]);
  });

  it("stubs every news/OSINT feed without inventing events", () => {
    const fetches = fetchNewsOsintSources();
    expect(fetches).toHaveLength(NEWS_OSINT_SOURCE_IDS.length);
    for (const result of fetches) {
      expect(result.observations).toEqual([]);
      expect(result.status).not.toBe("license_required");
      if (result.sourceId !== "src_federal_register") {
        expect(result.schema?.recordName).toBe("OsintEvent");
      }
    }
    expect(fetchNewsOsintSources().find((f) => f.sourceId === "src_google_news_rss")?.plan?.scrapePosture).toBe(
      "fragile_rss",
    );
    expect(getLayerAObservationSchema("src_gdelt")?.liveFetch).toBe(false);
  });

  it("does not treat URL-normalized duplicates as new events", () => {
    const first = normalizeRssItem({
      sourceId: "src_container_news",
      title: "A",
      link: "https://container-news.com/story/",
    })!;
    const second = normalizeRssItem({
      sourceId: "src_loadstar",
      title: "B",
      link: "https://container-news.com/story/#section",
    })!;
    expect(dedupeEvents([first, second])).toHaveLength(1);
  });
});
