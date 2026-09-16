# Data Factory — Day 0 (Procuro LoE)

**LoE = Procuro only. Not FSA.** John has no client or tenant data.
Layer B is deferred. This file is the honest map of what is public
versus what we will not build yet.

Pulse (recurring brief) and Diligence (point-in-time pack) sell the
same Layer A packages the API spine serves. They run in parallel. They
do not invent customer metrics.

## Layers

| Layer | What it is | Day 0 |
|---|---|---|
| **A** | Public / internet procurement, SC, logistics signals | Ingest spine: catalog, schemas, fetch stubs, packaged JSON |
| **B** | Opt-in tenant spend, FSA bridges, multi-tenant benchmarks | **Deferred.** No tables, no routes, no fake peers. |
| **C** | Labeled Decide → Learn on public signals (later moat) | Taxonomy stub aligned with [PR #30](https://github.com/foleysa/Procuro/pull/30) |

## What is public (shipped)

Code: `@workspace/data-factory`. API: authenticated `GET /api/data-factory/*`.
Schema: `data_factory_usage_log`, `data_factory_layer_c_labels` in `@workspace/db`.

### Layer A catalog

Families: `procurement`, `index`, `freight_commodity`, `disruption`, `filing`.

**Wired to existing collectors** (live fetch stays on the collector runtime;
this spine does not dump `market_signals`, including tenant-scoped rows):

| Source | Cited URL | Collector id |
|---|---|---|
| SAM.gov | https://open.gsa.gov/api/opportunities-api/ | `sam-gov` |
| USAspending | https://api.usaspending.gov/ | `usaspending` |
| FRED | https://fred.stlouisfed.org/docs/api/fred/ | `fred-economic-index` |
| BLS | https://www.bls.gov/developers/ | `bls-economic-index` |
| EIA | https://www.eia.gov/opendata/ | `eia-energy` |
| World Bank Pink Sheet | https://www.worldbank.org/en/research/commodity-markets | `world-bank-pink-sheet` |
| USGS minerals | https://www.usgs.gov/centers/national-minerals-information-center | `usgs-mineral` |
| ECB FX | https://data.ecb.europa.eu/ | `ecb-fx-rates` |
| Eurostat | https://ec.europa.eu/eurostat | `eurostat-economic-index` |
| USDA NASS | https://quickstats.nass.usda.gov/api | `usda-nass-economic-index` |
| Alpha Vantage commodities | https://www.alphavantage.co/documentation/ | `published-commodity-index` |
| GDELT | https://www.gdeltproject.org/ | `gdelt-events` |
| Natural hazards | https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php | `natural-hazards` |
| Sanctions lists | https://ofac.treasury.gov/sanctions-list-service | `government-sanctions` |
| SEC EDGAR | https://www.sec.gov/os/accessing-edgar-data | `sec-edgar` |
| Companies House | https://developer.company-information.service.gov.uk/ | `companies-house` |

**Fetch stubs** (URL cited, no live HTTP on Day 0):

- TED — https://ted.europa.eu/en/simap
- UK Contracts Finder — https://www.contractsfinder.service.gov.uk/apidocumentation
- BTS freight — https://www.bts.gov/ / https://data.bts.gov/

**Blocked pending human license approval** (catalogued, never fetched):

- Freightos Baltic Index — https://fbx.freightos.com/
- Cass Freight Index — https://www.cassinfo.com/freight-audit-payment/cass-transportation-indexes
- Shanghai Containerized Freight Index — https://en.sse.net.cn/

### Packaged datasets (JSON)

| Package id | Pulse / Diligence |
|---|---|
| `pkg_public_indices` | both |
| `pkg_public_procurement` | both |
| `pkg_public_freight_commodity` | both |
| `pkg_public_disruption` | Pulse |
| `pkg_public_filings` | Diligence |

Each package is `release: beta`, `ga: false`, `observations: []`.
No invented index values to make a pack “look live”.

### API spine (beta)

Authenticated (`tenantMiddleware` + `read`). Bearer API key or Clerk
session in production.

- `GET /api/data-factory` — status banner (honest beta)
- `GET /api/data-factory/sources`
- `GET /api/data-factory/sources/:sourceId`
- `GET /api/data-factory/packages`
- `GET /api/data-factory/packages/:packageId`
- `GET /api/data-factory/layer-c/taxonomy`

Metering: append-only `data_factory_usage_log`. Caller identity only.
Not a GA billing meter. A failed log write does not invent usage.

### Layer C taxonomy stub

Same Decide / Learn strings as PR #30 `@workspace/pulse`:

- Decide: `renegotiate` \| `dual_source` \| `switch_lane` \| `hold` \| `kill`
- Learn: `saved` \| `missed` \| `unknown` \| `reversed` (`unknown` is first-class)

Labels attach to **public signal ids**. `tenantLocalStakeUsd` is rejected.
No FSA engagement identifiers. When `@workspace/pulse` merges, re-export
from there — do not fork the enums.

## What is deferred (do not build)

- Tenant spend ingest, ERP/CSV bridges, mock multi-tenant spend
- FSA client files, Weekly Brief paths, FSA engagement ids
- Peer percentiles, ARR, savings %, “benchmark vs similar clients”
- Live fetch of paid freight/commodity indexes without a signed license
- GA claims, quota enforcement billed as a product
- Layer B warehouse or “anonymized” tenant aggregates

## Prove-it

```
pnpm --filter @workspace/data-factory test
```
