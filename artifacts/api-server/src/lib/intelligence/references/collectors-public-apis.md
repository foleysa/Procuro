# Public-API collectors (Phase 2)

Eight high-ROI free public-data collectors that share the
`IntelligenceCollector` contract. They write to GCS (raw payloads),
BigQuery (bitemporal warehouse), and Postgres (system of record), and
they all dedupe via `stableSignalKey` so reruns are idempotent.

| Collector ID         | Signal type            | Posture / tier  | Default cron     | Auth                          | Backfill route                                |
| -------------------- | ---------------------- | --------------- | ---------------- | ----------------------------- | --------------------------------------------- |
| `sec-edgar`          | `corporate_filing`     | public_api / T1 | `0 */6 * * *`    | `SEC_EDGAR_USER_AGENT` (opt.) | `POST /collectors/sec-edgar/backfill`         |
| `gdelt-events`       | `event_geocoded`       | public_api / T2 | `*/15 * * * *`   | none                          | —                                             |
| `government-sanctions` | `sanctions_match`    | public_api / T1 | `0 */4 * * *`    | none                          | —                                             |
| `opensanctions`      | `risk_screening_match` | public_api / T2 | `0 3 * * *`      | none                          | `POST /collectors/opensanctions/backfill`     |
| `gleif-lei`          | `entity_registry`      | public_api / T1 | `0 5 * * *`      | none                          | `POST /collectors/gleif-lei/backfill`         |
| `climate-trace`      | `facility_emissions`   | public_api / T2 | `0 6 * * 1`      | none                          | `POST /collectors/climate-trace/backfill`     |
| `natural-hazards`    | `natural_hazard`       | public_api / T1 | `*/15 * * * *`   | none                          | —                                             |
| `companies-house`    | `corporate_filing`     | public_api / T1 | `0 */12 * * *`   | `COMPANIES_HOUSE_API_KEY`     | `POST /collectors/companies-house/backfill`   |

All collectors are registered in `artifacts/api-server/src/index.ts` and
share the runtime that handles dedupe, BQ merge, GCS landing, and
job-run logging.

## Collector details

### `sec-edgar` — SEC EDGAR submissions

Polls `https://data.sec.gov/submissions/CIK{CIK}.json` for a curated
issuer list. Only `TRACKED_FORM_CODES` (10-K, 10-Q, 8-K, DEF 14A,
NT 10-K, etc.) are emitted; one MarketSignalDraft per filing with the
accession number in `scope_sku` so same-day filings stay distinct.
`entityUid` is `ent_cik_<padded10>`.

- **Endpoint shape:** SEC submissions JSON (parallel arrays per form).
- **Backfill:** `POST /collectors/sec-edgar/backfill`
  - body: `{ "issuers": [{ "cik": "320193", "name": "Apple Inc.", "lei": "...", "ticker": "AAPL" }] }`
- **User-agent:** SEC requires a contact email. Fallback is provided
  but production deployments must set `SEC_EDGAR_USER_AGENT`.

### `gdelt-events` — GDELT 2.0 events

Reads `lastupdate.txt`, downloads the latest `.export.CSV.zip`, and
emits one geocoded event per row (event id in `scope_sku`, country code
in `scope_lane_key`, EventCode numeric in `value`). Capped at
`GDELT_MAX_EVENTS_PER_RUN` (~5k) per tick to stay polite.

- **Endpoint:** `http://data.gdeltproject.org/gdeltv2/lastupdate.txt`
- **Backfill:** none (15-minute cadence already keeps history fresh).

### `government-sanctions` — combined OFAC + EU + UK + UN

Single collector that pulls four official open consolidated sanctions
lists in parallel and emits one `sanctions_match` per entry. Each list
contributes its own numeric `value` via `SANCTIONS_LIST_CODES` (1=OFAC,
2=EU, 3=UK, 4=UN). `entityUid` is `ent_sanctions_<list>_<entryId>`.

- **OFAC SDN XML:** `https://www.treasury.gov/ofac/downloads/sdn.xml`
- **EU consolidated:** `https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw`
- **UK OFSI CSV:** `https://ofsistorage.blob.core.windows.net/publishlive/2022format/ConList.csv`
- **UN consolidated:** `https://scsanctions.un.org/resources/xml/en/consolidated.xml`
- **Partial-outage:** if at least one list returns rows, the run
  succeeds and the failures are logged.

### `opensanctions` — OpenSanctions bulk JSONL

Streams the public OpenSanctions sanctioned entities + PEPs JSONL
dataset, emits one `risk_screening_match` per entity. Resolution
prefers GLEIF LEI when present (`ent_lei_<lei>`), otherwise falls back
to the OpenSanctions id (`ent_opensanctions_<id>`).

- **Endpoint:** `https://data.opensanctions.org/datasets/latest/sanctions/entities.ftm.json`
- **Backfill:** `POST /collectors/opensanctions/backfill`
  - body: `{ "cap": 50000 }` (defaults to a few-thousand-row sample).

### `gleif-lei` — GLEIF Level-1 LEI registry

Polls `https://api.gleif.org/api/v1/lei-records`, sorted by most
recently updated. One `entity_registry` MarketSignal per record with
the LEI in `scope_sku` and the registration-status code in `value`
(`GLEIF_REGISTRATION_STATUS_CODES`). `entityUid` = `ent_lei_<LEI>`.

- **Endpoint:** GLEIF JSON:API.
- **Backfill:** `POST /collectors/gleif-lei/backfill`
  - body: `{ "maxPages": 25, "pageSize": 200 }`.

### `climate-trace` — ClimateTRACE facility emissions

Pulls the ClimateTRACE asset-emissions search API. One
`facility_emissions` MarketSignal per facility (owner in
`scope_supplier_name`, asset id in `scope_sku`, sector in
`scope_category_code`, latest annual CO2e in `value`). Owner is
slugified into `ent_climatetrace_owner_<slug>` for cross-source joins.

- **Endpoint:** `https://api.climatetrace.org/v6/assets`
- **Backfill:** `POST /collectors/climate-trace/backfill`
  - body: `{ "maxPages": 10, "sector": "steel", "country": "DEU" }`.

### `natural-hazards` — combined USGS + NOAA NWS + NASA EONET + GDACS

Single collector that polls four feeds and emits one `natural_hazard`
per event. Each sub-source contributes its `value` via
`HAZARD_SOURCE_CODES` (1=USGS, 2=NWS, 3=EONET, 4=GDACS) so dedupe stays
unique even if event ids collide between feeds.

- **USGS earthquakes (M4.5+ / 1h):** GeoJSON.
- **NOAA NWS active alerts (US):** GeoJSON.
- **NASA EONET v3 events (open / 7d):** JSON.
- **GDACS multi-hazard alerts:** RSS XML.
- **Partial-outage:** if at least one source returns rows the run
  succeeds; only fails when all four error.

### `companies-house` — UK Companies House filing histories

Polls `/company/{number}/filing-history` for a curated set of UK
company numbers (`COMPANIES_HOUSE_DEFAULT_NUMBERS`). One
`corporate_filing` per filing (transaction id in `scope_sku`,
filing-category code in `value` via `FILING_CATEGORY_CODES`).
`entityUid` = `ent_companies_house_<number>`.

- **Endpoint:** `https://api.company-information.service.gov.uk/...`
- **Auth:** `COMPANIES_HOUSE_API_KEY` (free key, basic-auth user with
  empty password — handled internally).
- **Backfill:** `POST /collectors/companies-house/backfill`
  - body: `{ "numbers": ["00006245", "02099500"] }`.

## Environment variables

| Variable                     | Required by         | Purpose                                                       |
| ---------------------------- | ------------------- | ------------------------------------------------------------- |
| `SEC_EDGAR_USER_AGENT`       | `sec-edgar`         | Polite identifier (`name email@domain`). Fallback exists.     |
| `COMPANIES_HOUSE_API_KEY`    | `companies-house`   | Free API key from developer.company-information.service.gov.uk. |

## Backfill route contract

All five backfill endpoints share the same shape:

- **Method:** `POST`
- **Auth:** `requirePlatformAdmin` middleware (admin-only).
- **Success body:**
  ```json
  {
    "collectorId": "gleif-lei",
    "daysWritten": 1,
    "signalsInserted": 412,
    "signalsSkipped": 0,
    "durationMs": 8123
  }
  ```
- **Preflight 409:** kill switch / not-approved / missing API key /
  missing user-agent all return HTTP 409 with the upstream message and
  the `collectorId`.

## Entity resolution

Every draft sets `entityUid` so downstream joins can stitch signals
across collectors. The deterministic prefix scheme:

| Source                  | UID format                                |
| ----------------------- | ----------------------------------------- |
| SEC CIK                 | `ent_cik_<padded10>`                      |
| GLEIF LEI               | `ent_lei_<LEI>`                           |
| OFAC / EU / UK / UN     | `ent_sanctions_<list>_<entryId>`          |
| OpenSanctions (no LEI)  | `ent_opensanctions_<id>`                  |
| ClimateTRACE owner      | `ent_climatetrace_owner_<slug>`           |
| Companies House         | `ent_companies_house_<number>`            |

`MarketSignalDraft.entityUid` is threaded through the runtime to BQ
(`entity_uid_nullable`) and into Postgres `metadata.entityUid` so
cross-source queries don't need a separate dimension table.

## Tests

Each collector has a parser unit test under
`artifacts/api-server/test/<collector-id>-parser.test.ts`. The pattern
is uniform: parse an inline fixture, assert the draft shape, validate
against `collector.signalSchema`, and assert
`collector.stableSignalKey()` is unique per row + idempotent across
re-parses. Run individually:

```bash
node --import tsx --test artifacts/api-server/test/sec-edgar-parser.test.ts
```
