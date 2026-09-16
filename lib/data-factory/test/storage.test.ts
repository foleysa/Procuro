import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { NEWS_EVENTS_DDL, NEWS_EVENTS_GDELT_JOIN_SQL } from "@workspace/intelligence/bq";
import {
  DATA_FACTORY_STORAGE_LAYOUT,
  NEWS_EVENTS_FORBIDDEN_COLUMNS,
  assertNewsLandingAllowed,
  dataFactoryRawCollectorId,
  dataFactoryRawPath,
  landDataFactoryRaw,
  toNewsEventServingRow,
} from "../src/storage";
import { newsOsintMetadataStream } from "../src/events";
import { dataFactoryStatus } from "../src/status";

describe("locked storage layout", () => {
  it("reuses intelligence GCS + BQ + Postgres serving tables", () => {
    expect(DATA_FACTORY_STORAGE_LAYOUT.gcs.reuse).toBe(
      "INTELLIGENCE_GCS_RAW_BUCKET",
    );
    expect(DATA_FACTORY_STORAGE_LAYOUT.postgres.tables.market_signals).toMatch(
      /serving/i,
    );
    expect(DATA_FACTORY_STORAGE_LAYOUT.postgres.tables.news_events).toMatch(
      /metadata only/i,
    );
    expect(
      DATA_FACTORY_STORAGE_LAYOUT.postgres.tables.data_factory_usage_log,
    ).toMatch(/metering/i);
    expect(DATA_FACTORY_STORAGE_LAYOUT.bigquery.tables).toContain(
      "news_events",
    );
    expect(DATA_FACTORY_STORAGE_LAYOUT.bigquery.gdeltJoins).toMatch(/GDELT|gdelt|event_geocoded/);
  });

  it("forbids article-HTML columns and landing", () => {
    for (const col of NEWS_EVENTS_FORBIDDEN_COLUMNS) {
      expect(["html", "html_body", "body", "full_text", "content", "content_encoded", "article_html", "summary"]).toContain(
        col,
      );
    }
    expect(() =>
      assertNewsLandingAllowed({ extension: "html", contentType: "text/html" }),
    ).toThrow(/refuses article HTML/);
    expect(() =>
      assertNewsLandingAllowed({ extension: "xml", contentType: "application/rss+xml" }),
    ).not.toThrow();
  });

  it("builds the existing intelligence raw path shape", () => {
    const path = dataFactoryRawPath({
      sourceId: "src_freightwaves_rss",
      runId: "run-1",
      observedAt: new Date("2026-09-16T00:00:00.000Z"),
      extension: "xml",
    });
    expect(path).toBe(
      "df_src_freightwaves_rss/2026/09/16/run-1.xml",
    );
    expect(dataFactoryRawCollectorId("src_gdelt")).toBe("df_src_gdelt");
  });

  it("no-ops GCS landing when GCP is unset (same as intelligence)", async () => {
    const result = await landDataFactoryRaw({
      sourceId: "src_bbc_business",
      runId: "run-ci",
      observedAt: new Date("2026-09-16T00:00:00.000Z"),
      payload: "<rss></rss>",
      extension: "xml",
      contentType: "application/rss+xml",
    });
    expect(result).toBeNull();
  });

  it("projects events to serving rows without HTML fields", () => {
    const row = toNewsEventServingRow(
      {
        title: "Canal watch",
        url: "https://gcaptain.com/canal/",
        published: "2026-09-16T00:00:00.000Z",
        source: "src_gcaptain",
        entities: ["Panama"],
        event_type: "maritime",
        severity: "watch",
      },
      { id: "nws_1", rawPayloadPointer: "gs://bucket/df_src_gcaptain/2026/09/16/run.xml" },
    );
    expect(row).not.toHaveProperty("html");
    expect(row).not.toHaveProperty("fullText");
    expect(row.title).toBe("Canal watch");
    expect(newsOsintMetadataStream([]).events).toEqual([]);
  });

  it("extends the existing BQ warehouse with news_events + GDELT join SQL", () => {
    const cfg = {
      projectId: "p",
      bqDataset: "market_signals_warehouse",
      bqLocation: "US",
      gcsRawBucket: "raw",
      maxBytesBilled: 1,
      defaultTableExpirationMs: 1,
      enabled: true,
    };
    expect(NEWS_EVENTS_DDL(cfg)).toMatch(/news_events/);
    expect(NEWS_EVENTS_DDL(cfg)).not.toMatch(/html_body|full_text/);
    expect(NEWS_EVENTS_GDELT_JOIN_SQL(cfg)).toMatch(/event_geocoded/);
    expect(NEWS_EVENTS_GDELT_JOIN_SQL(cfg)).toMatch(/entity_news_event/);
  });

  it("ships an idempotent Postgres seed that does not recreate market_signals", () => {
    const sql = readFileSync(
      resolve(process.cwd(), "../db/seeds/data-factory-day0.sql"),
      "utf8",
    );
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS news_events/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS data_factory_usage_log/);
    expect(sql).toMatch(/Reuses existing `market_signals`/);
    expect(sql).not.toMatch(/CREATE TABLE IF NOT EXISTS market_signals/);
    expect(sql).not.toMatch(/\bhtml_body\b|\bfull_text\b/);
  });

  it("advertises the locked layout on the status banner", () => {
    const notes = dataFactoryStatus().notes.join(" ");
    expect(notes).toMatch(/INTELLIGENCE_GCS_RAW_BUCKET/);
    expect(notes).toMatch(/news_events/);
    expect(notes).toMatch(/Vertex Agent Engine is deferred/);
  });
});
