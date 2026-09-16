# Data Factory — Day 0 (Procuro LoE)

**John GREENLIGHT 2026-09-16: GO** on storage layout + Day 0 factory.

**Source map FROZEN** (John: discovery done). Priority: Tier 1 → 1.5 →
1.5b → light Tier C. Do **not** invent new sources.

**LoE = Procuro only. Not FSA.** John has no client or tenant data.
Layer B is deferred. This file is the locked Layer A source map for
product decisions.

**Flow:** GCS raw landing → Postgres serving (`market_signals`,
`news_events`, metering) → BigQuery analytics / GDELT joins.

The old 8-source “wire first” list was **weak**. Day 0 now implements
stubs + schemas for **all of strengthened Tier 1**, the **Tier 1.5
gap pack** (plus optional 1.5b), then Tier 2 file/CSV / careful pages.
Paid commercial feeds stay `license_required` placeholders. **No
MarineTraffic.**

Pulse (recurring brief) and the API spine sell the same public Layer A
packages in parallel. They do not invent customer metrics.

`channelUse` on each source/package: **pulse** | **api** | **both**.

## Layers

| Layer | What it is | Day 0 |
|---|---|---|
| **A** | Public / internet procurement, SC, logistics signals | Catalog, observation schemas, fetch stubs, packaged JSON |
| **B** | Opt-in tenant spend, FSA bridges, multi-tenant benchmarks | **Deferred.** |
| **C** | Labeled Decide → Learn on public signals | Taxonomy stub aligned with [PR #30](https://github.com/foleysa/Procuro/pull/30) |

## Tier 1 — implement stubs for ALL of these

Package: `pkg_tier1` (`channelUse: both`). `pkg_day0_wire_first` is a
deprecated alias of the same source list.

openFDA is split into food enforcement + drug/device recalls (16 catalog
ids for the 15 numbered items).

| # | Source | `channelUse` | Status | Cited URL |
|---|---|---|---|---|
| 1 | BLS Public Data API v2 (PPI) | both | stub + schema; existing collector `bls-economic-index` | https://www.bls.gov/developers/api_signature_v2.htm |
| 2 | FRED API | both | stub + schema; existing collector `fred-economic-index` | https://fred.stlouisfed.org/docs/api/fred/ |
| 3 | EIA Open Data API v2 | both | stub + schema; existing collector `eia-energy` | https://www.eia.gov/opendata/documentation.php |
| 4 | USDA MyMarketNews API | both | stub + schema | https://mymarketnews.ams.usda.gov/public_data_api |
| 5 | openFDA (food + recalls) | pulse | stub + schema (food enforcement + drug/device enforcement) | https://open.fda.gov/apis/food/enforcement/ |
| 6 | OFAC SDN CSV/XML | both | stub + schema; existing collector `government-sanctions` | https://ofac.treasury.gov/sanctions-list-service |
| 7 | Federal Register API | pulse | stub + schema | https://www.federalregister.gov/developers/documentation/api/v1 |
| 8 | SEC EDGAR APIs | api | stub + schema; existing collector `sec-edgar` | https://www.sec.gov/os/accessing-edgar-data |
| 9 | BTS data.bts.gov Monthly TEU (Socrata) | both | stub + schema — **do not invent a 4×4 dataset id** | https://www.bts.gov/PPFS |
| 10 | api.weather.gov alerts | pulse | stub + schema | https://www.weather.gov/documentation/services-web-api |
| 11 | USAspending.gov API | api | stub + schema; existing collector `usaspending` | https://api.usaspending.gov/ |
| 12 | Census Foreign Trade / FT-900 | both | file/CSV stub + schema | https://www.census.gov/foreign-trade/Press-Release/current_press_release/index.html |
| 13 | Census M3 | both | stub + schema | https://www.census.gov/manufacturing/m3/index.html |
| 14 | World Bank Pink Sheet monthly | both | file stub + schema; existing collector `world-bank-pink-sheet` | https://www.worldbank.org/en/research/commodity-markets |
| 15 | UN Comtrade free tier / bulk | both | stub + schema — free/bulk only where terms allow | https://comtradedeveloper.un.org/ |

## Tier 2 — file / CSV / careful pages

Package: `pkg_tier2`. Cass and SCFI are **cite-only** (`license_required`).

| Source | `channelUse` | Posture | Cite |
|---|---|---|---|
| Port of LA statistics | pulse | careful public page | https://www.portoflosangeles.org/business/statistics |
| Port of Long Beach statistics | pulse | careful public page | https://polb.com/business/port-statistics/ |
| USGS Mineral Commodity Summaries | both | file/CSV; existing `usgs-mineral` | https://www.usgs.gov/centers/national-minerals-information-center/commodity-statistics-and-information |
| USDA ERS data products | both | file/CSV | https://www.ers.usda.gov/data-products |
| CPSC / SaferProducts recalls | pulse | public API stub | https://www.cpsc.gov/Recalls |
| Fed Beige Book | pulse | careful public page | https://www.federalreserve.gov/monetarypolicy/beige-book-default.htm |
| NAICS codes | api | file/CSV | https://www.census.gov/naics/ |
| UNSPSC codes | api | file/CSV (registration) | https://www.unspsc.org/ |
| Cass Freight Index | both | **cite-only** | https://www.cassinfo.com/freight-audit-payment/cass-transportation-indexes |
| NHC tropical cyclone GIS | pulse | file/CSV | https://www.nhc.noaa.gov/gis/ |
| FDA recalls dashboard | pulse | careful page — prefer openFDA | https://datadashboard.fda.gov/ora/cd/recalls.htm |
| SAM.gov opportunities | api | careful; existing `sam-gov` | https://open.gsa.gov/api/opportunities-api/ |
| SCFI | both | **cite-only — do not scrape** | https://en.sse.net.cn/ |
| IMF primary commodity prices | both | file/CSV | https://www.imf.org/en/Research/commodity-prices |
| USACE waterborne commerce | both | file/CSV **if open** | https://www.iwr.usace.army.mil/About/Technical-Centers/WCSC-Waterborne-Commerce-Statistics-Center/ |
| EPA TRI | both | file/CSV | https://www.epa.gov/toxics-release-inventory-tri-program |

## Paid feeds — `license_required` placeholders only

Do **not** implement fetch. Catalog + refuse.

| Source | `channelUse` | Cite |
|---|---|---|
| DAT | both | https://www.dat.com/ |
| Freightos (FBX) | both | https://fbx.freightos.com/ |
| Xeneta | both | https://www.xeneta.com/ |
| Drewry | both | https://www.drewry.co.uk/ |
| SONAR | both | https://sonar.freightwaves.com/ |
| LME | both | https://www.lme.com/ |
| CME | both | https://www.cmegroup.com/ |
| ISM ROB | pulse | https://www.ismworld.org/supply-management-news-and-reports/reports/ism-report-on-business/ |
| S&P Commodity Insights | both | https://www.spglobal.com/commodityinsights/ |
| Fastmarkets | both | https://www.fastmarkets.com/ |
| JOC | pulse | https://www.joc.com/ |

Package: `pkg_license_required`. Cass and SCFI are **not** in this pack;
they sit on Tier 2 as cite-only.

## Other packages

| Package | `channelUse` | Notes |
|---|---|---|
| `pkg_public_indices` | both | BLS, FRED, EIA, USDA MMN, Census M3, World Bank |
| `pkg_public_disruption` | pulse | openFDA food + recalls, OFAC SDN, Federal Register, NWS |
| `pkg_public_freight_commodity` | both | BTS TEU, FT-900, Comtrade, POLA/POLB, USACE, Cass/SCFI cite |
| `pkg_public_procurement` | api | USAspending, SAM.gov (careful) |
| `pkg_public_filings` | api | SEC EDGAR |
| `pkg_news_osint` | both | RSS metadata events + Pulse cited bullets |
| `pkg_tier15` | both | Free gap pack (WITS → AISHub). No MarineTraffic |
| `pkg_tier15b` | both | UFLPA, USITC remedies + DataWeb/HTS, CH, WDI, Panama Canal cite, PHMSA, Wikidata; ACLED gated |
| `pkg_tier_c` | both | Light backlog: BIS, OpenSanctions UK/EU, FRA/STB, NOAA PORTS, OC ToS, OWID, USPTO, FTC/AG |

Pulse-useful: Tier 1 disruption + Tier 2 port / NHC / CPSC pages.
API-useful: BLS/FRED/EIA/Census/Comtrade series, OFAC, USAspending, EDGAR, SAM.
Both: `pkg_tier1`.

## API spine (beta, `ga: false`)

Authenticated `GET /api/data-factory/*`. Query `channelUse=pulse|api|both`
and `day0Tier=tier_1|tier_1_5|tier_1_5b|tier_2|tier_c|news_osint|license_required`.

- `GET /api/data-factory`
- `GET /api/data-factory/sources`
- `GET /api/data-factory/packages`
- `GET /api/data-factory/packages/pkg_tier1`
- `GET /api/data-factory/events`
- `GET /api/data-factory/layer-c/taxonomy`

Metering: `data_factory_usage_log`. Not a GA billing meter.

## Parallel track — open-source news / OSINT

Package: `pkg_news_osint` (`channelUse: both`). Pipeline: **RSS →
normalize → dedupe → event schema**. Day 0 returns an empty event
stream (`events: []`) and empty Pulse cited bullets. No invented
headlines.

Event fields: `title`, `url`, `published`, `source`, `entities[]`,
`event_type`, `severity`.

**ToS:** headlines + link = OK. Full-text republish / storing article
HTML bodies as product payloads = **out of scope**.

| Source | Notes | Cite |
|---|---|---|
| CBP GovDelivery / CSMS | Stub **if public**; confirm RSS before live fetch | https://www.cbp.gov/trade/automated/cargo-systems-messaging-service |
| Federal Register | Reuses Tier 1 `src_federal_register` (+ documents.rss) | https://www.federalregister.gov/developers/documentation/api/v1 |
| FreightWaves RSS | Not SONAR | https://www.freightwaves.com/feed |
| Supply Chain Dive RSS | Headline + link | https://www.supplychaindive.com/feeds/news/ |
| gCaptain | Headline + link | https://gcaptain.com/feed/ |
| Maritime Executive | Headline + link | https://www.maritime-executive.com/rss.xml |
| Splash247 | Headline + link | https://splash247.com/feed/ |
| The Loadstar | Headline + link | https://theloadstar.com/feed/ |
| Container News | Headline + link | https://container-news.com/feed/ |
| BBC Business RSS | Syndication: headline + link | https://feeds.bbci.co.uk/news/business/rss.xml |
| GDELT DOC API | Event graph metadata + source URLs | https://api.gdeltproject.org/api/v2/doc/doc |
| Google News RSS | **Optional / fragile** — not a GA dependency | https://news.google.com/rss/search |
| GDACS | Disaster RSS | https://www.gdacs.org/xml/rss.xml |
| USGS significant quakes | Distinct from USGS MCS | https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_week.atom |
| NHC products | Complements Tier 2 `src_nhc` GIS | https://www.nhc.noaa.gov/index-at.xml |

API metadata stream: `GET /api/data-factory/events`.
Pulse packaging: cited bullets `{ text, url, source, published }`.

## Tier 1.5 gap pack (free)

Package: `pkg_tier15`. Stubs for every source. GDACS is reused from the
news/OSINT track. **No paid MarineTraffic.**

| Source | Status | Cite |
|---|---|---|
| World Bank WITS | stub | https://wits.worldbank.org/witsapi.html |
| Eurostat | existing `eurostat-economic-index` | https://ec.europa.eu/eurostat/web/main/data/database |
| Eurostat Comext | stub (trade, not PPI) | https://ec.europa.eu/eurostat/web/international-trade-in-goods/data |
| TED Europa | stub | https://ted.europa.eu/ |
| OpenSanctions | existing `opensanctions` | https://www.opensanctions.org/ |
| GLEIF LEI | existing `gleif-lei` | https://www.gleif.org/en/lei-data/gleif-api |
| FAOSTAT | stub | https://www.fao.org/faostat/en/#data |
| OECD SDMX | stub | https://data.oecd.org/ |
| BEA API | stub (free key) | https://apps.bea.gov/api/signup/ |
| ReliefWeb | stub | https://apidoc.reliefweb.int/ |
| GDACS | reused news/OSINT stub | https://www.gdacs.org/ |
| OpenSky | stub (free REST) | https://opensky-network.org/ |
| AISHub | free AIS / contributor API only | https://www.aishub.net/api |

### Optional 1.5b (John locked)

Package: `pkg_tier15b`.

| Source | Status | Cite |
|---|---|---|
| UFLPA entity list | careful page stub | https://www.dhs.gov/uflpa-entity-list |
| USITC / ITA trade remedies | careful page stub | https://www.usitc.gov/trade_remedy |
| USITC DataWeb / HTS | file/CSV stub | https://dataweb.usitc.gov/ |
| Companies House | existing `companies-house` | https://developer.company-information.service.gov.uk/ |
| World Bank WDI | stub (not Pink Sheet) | https://data.worldbank.org/ |
| Panama Canal advisories | cite-only careful page | https://pancanal.com/en/ |
| PHMSA incident / hazmat | file/CSV stub | https://www.phmsa.dot.gov/data-and-statistics/pipeline/data-and-statistics-overview |
| Wikidata reconcile helper | SPARQL stub | https://www.wikidata.org/wiki/Wikidata:Data_access |
| ACLED | **license_required** until license is clear | https://acleddata.com/ |

## Tier C — light backlog (do not block the PR)

Package: `pkg_tier_c`. Source map frozen — no invented extras.

| Source | Status | Cite |
|---|---|---|
| BIS Entity List | file/CSV stub | https://www.bis.doc.gov/index.php/policy-guidance/lists-of-parties-of-concern/entity-list |
| BIS Denied Persons | file/CSV stub | https://www.bis.doc.gov/index.php/policy-guidance/lists-of-parties-of-concern/denied-persons-list |
| UK/EU sanctions files | reuse OpenSanctions (OFSI + EU FSF cites) | https://www.opensanctions.org/ |
| FRA safety extras | file/CSV stub | https://safetydata.fra.dot.gov/ |
| STB extras | careful page stub | https://www.stb.gov/ |
| NOAA PORTS | stub | https://tidesandcurrents.noaa.gov/ports.html |
| OpenCorporates | ToS gate — no live fetch until legal review | https://opencorporates.com/ |
| OWID cite helper | cite-only | https://ourworldindata.org/ |
| USPTO ODP | stub | https://developer.uspto.gov/api-catalog |
| FTC / AG RSS | headline + link only | https://www.ftc.gov/feeds/press-release.xml |

## Storage layout (locked — John confirmed)

Reuse `@workspace/intelligence` GCS + BigQuery and existing Drizzle
schemas. **Do not invent a second stack.**

| Store | Role | What lives here |
|---|---|---|
| **GCS** | Raw landing | Same bucket as collectors: `INTELLIGENCE_GCS_RAW_BUCKET` (alias `GCS_RAW_BUCKET`). Path `gs://<bucket>/<collectorId>/<YYYY/MM/DD>/<runId>.<ext>` via `landRawPayload`. News/OSINT lands **RSS/Atom/JSON bytes only** — never article HTML. |
| **Postgres** | Serving | `market_signals` (existing collector facts). `news_events` (metadata only: title, url, published, source, entities, event_type, severity, optional `raw_payload_pointer`). `data_factory_usage_log` (API metering). `data_factory_layer_c_labels`. |
| **BigQuery** | Analytics / history | Same `market_signals_warehouse` dataset (`INTELLIGENCE_BQ_DATASET`). Tables: `market_signals`, `collector_runs`, `entities`, plus `news_events`. **GDELT joins** are query-time: `news_events.url` ↔ `market_signals` rows with `signal_type` in `event_geocoded` / `entity_news_event`. Helpers no-op when GCP is unset. |

Helpers: `landDataFactoryRaw` wraps `landRawPayload`. BQ bootstrap:
`ensureWarehouseSchema` now includes `NEWS_EVENTS_DDL`. Join SQL:
`NEWS_EVENTS_GDELT_JOIN_SQL`.

`news_events` **must not** grow `html` / `body` / `full_text` columns.

### Apply when env vars are set (do not block on live GCP)

| Env | What it enables | If unset |
|---|---|---|
| `DATABASE_URL` | Drizzle `pnpm --filter @workspace/db push` **or** `lib/db/seeds/data-factory-day0.sql` (`market_signals` already exists; this seed adds `news_events` + metering + Layer C) | Schema files still compile; no live write |
| `INTELLIGENCE_GCS_RAW_BUCKET` (+ `INTELLIGENCE_GCP_PROJECT_ID` + creds) | `landRawPayload` / `landDataFactoryRaw` | Helpers return `null` |
| `INTELLIGENCE_BQ_DATASET` (same GCP project/creds) | `ensureWarehouseSchema` creates `news_events` in `market_signals_warehouse` | Helpers no-op |
| `AI_INTEGRATIONS_GEMINI_*` | Optional Orient summary | Hook skipped |
| `DATA_FACTORY_PUBSUB_TOPIC` | Optional new-event publish | Hook skipped |

## Optional hooks (after collectors write)

| Hook | Env | Day 0 |
|---|---|---|
| Pub/Sub new-events topic | `DATA_FACTORY_PUBSUB_TOPIC` or `INTELLIGENCE_PUBSUB_TOPIC` | Stub — no-op if unset |
| Gemini Orient summary | `AI_INTEGRATIONS_GEMINI_API_KEY` + `AI_INTEGRATIONS_GEMINI_BASE_URL` (`@google/genai`, same as `@workspace/integrations-gemini-ai`) | Stub — headlines + links only |
| Vertex Agent Engine | — | **Deferred.** Agents/analysis come after collectors write data. Do not block this PR. |

## Deferred

- Layer B tenant spend, FSA files, peer percentiles
- Live fetch of any `license_required` feed
- Invented Socrata 4×4 ids, TEU, index, or savings values
- POLA/POLB HTML scrape (schema only; careful scrape later)
- Client / tenant data of any kind
- Full-text republish or article-HTML product payloads (news/OSINT)

## Prove-it

```
pnpm --filter @workspace/data-factory test
```

No live GCP credentials required for tests or this PR.
