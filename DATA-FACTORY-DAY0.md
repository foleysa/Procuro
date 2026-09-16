# Data Factory — Day 0 (Procuro LoE)

**LoE = Procuro only. Not FSA.** John has no client or tenant data.
Layer B is deferred. This file is the live Layer A source map for
product decisions.

Pulse (recurring brief) and the API spine sell the same public Layer A
packages in parallel. They do not invent customer metrics.

`channelUse` on each source/package: **pulse** | **api** | **both**.

## Layers

| Layer | What it is | Day 0 |
|---|---|---|
| **A** | Public / internet procurement, SC, logistics signals | Catalog, observation schemas, fetch stubs, packaged JSON |
| **B** | Opt-in tenant spend, FSA bridges, multi-tenant benchmarks | **Deferred.** |
| **C** | Labeled Decide → Learn on public signals | Taxonomy stub aligned with [PR #30](https://github.com/foleysa/Procuro/pull/30) |

## Day 0 WIRE FIRST (public/open)

Implement fetch stubs + schema first. No invented observations.

| Rank | Source | `channelUse` | Status | Cited URL |
|---|---|---|---|---|
| 1 | FRED API | **both** | stub + schema; existing collector `fred-economic-index` | https://fred.stlouisfed.org/docs/api/fred/ |
| 2 | EIA API v2 | **both** | stub + schema; existing collector `eia-energy` | https://www.eia.gov/opendata/documentation.php |
| 3 | openFDA food enforcement | **pulse** | stub + schema | https://open.fda.gov/apis/food/enforcement/ |
| 4 | OFAC SDN | **both** | stub + schema; existing collector `government-sanctions` | https://www.treasury.gov/ofac/downloads/sdn.xml |
| 5 | api.weather.gov | **pulse** | stub + schema (also inside `natural-hazards`) | https://www.weather.gov/documentation/services-web-api |
| 6 | BTS TEU | **both** | stub + schema | https://www.bts.gov/browse-statistical-products-and-data/freight-facts-and-figures |
| 7 | POLA / POLB | **pulse** | careful public-page stub — no scrape yet | https://www.portoflosangeles.org/business/statistics · https://polb.com/business/port-statistics/ |
| 8 | Cass Freight Index | **both** | **cite-only** until license (`license_required`) | https://www.cassinfo.com/freight-audit-payment/cass-transportation-indexes |

Package: `pkg_day0_wire_first` (`channelUse: both`).

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
| Cass | both | see wire-first #8 |

Package: `pkg_license_required`.

## Other packages

| Package | `channelUse` | Notes |
|---|---|---|
| `pkg_public_indices` | both | FRED + EIA + BLS + World Bank |
| `pkg_public_disruption` | pulse | openFDA, OFAC SDN, NWS |
| `pkg_public_freight_commodity` | both | BTS TEU, POLA/POLB, plus paid placeholders |
| `pkg_public_procurement` | api | SAM.gov, USAspending (existing collectors) |
| `pkg_public_filings` | api | SEC EDGAR (existing collector) |

Pulse-useful: wire-first disruption + port pages + ISM/JOC (when licensed).
API-useful: FRED/EIA/BTS series, OFAC, SAM, USAspending, EDGAR.
Both: the Day 0 wire-first pack and public indices.

## API spine (beta, `ga: false`)

Authenticated `GET /api/data-factory/*`. Query `channelUse=pulse|api|both`
and `day0Tier=wire_first|existing_collector|license_required`.

- `GET /api/data-factory`
- `GET /api/data-factory/sources`
- `GET /api/data-factory/packages`
- `GET /api/data-factory/packages/pkg_day0_wire_first`
- `GET /api/data-factory/layer-c/taxonomy`

Metering: `data_factory_usage_log`. Not a GA billing meter.

## Deferred

- Layer B tenant spend, FSA files, peer percentiles
- Live fetch of any `license_required` feed
- POLA/POLB HTML scrape (schema only; careful scrape later)
- Invented TEU / index / savings values

## Prove-it

```
pnpm --filter @workspace/data-factory test
```
