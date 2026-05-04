# Performance Baselines

Established baseline numbers for every critical API endpoint. These baselines
serve as regression detection thresholds — a p95 regression > 20% from these
values should be investigated and treated as a failure.

## Test Conditions

| Parameter | Value |
|---|---|
| Database | PostgreSQL 16, local |
| Data volume | 50,000 opportunities, ~150,000 stage history rows |
| Tenant | `org_soak_test` (dedicated soak-test org) |
| Connection pool | Default `PG_POOL_MAX` |
| Server | Single-process Node.js (Express 5) |

## Endpoint Baselines

> **Note:** Fill in measured values after running the load test for the first time.
> Run: `k6 run tests/performance/load.k6.js -e PERF_TENANT_ID=org_soak_test`

| Endpoint | p50 (ms) | p95 (ms) | p99 (ms) | Threshold |
|---|---|---|---|---|
| `GET /api/today/feed` | _TBD_ | _TBD_ | _TBD_ | p95 ≤ 1500ms |
| `GET /api/opportunities?limit=50&canonicalStage=Identified` | _TBD_ | _TBD_ | _TBD_ | p95 ≤ 1500ms |
| `GET /api/opportunities/:id` | _TBD_ | _TBD_ | _TBD_ | p95 ≤ 1500ms |
| `GET /api/opportunities/gate-summary` | _TBD_ | _TBD_ | _TBD_ | p95 ≤ 1500ms |

## Stress Test Breaking Point

> **Note:** Fill in after running the stress test.
> Run: `k6 run tests/performance/stress.k6.js -e PERF_TENANT_ID=org_soak_test`

| Metric | Value |
|---|---|
| VU count where p95 > 3000ms | _TBD_ |
| Peak VUs tested | 800 |
| Feed p95 at peak | _TBD_ ms |
| Gate summary p95 at peak | _TBD_ ms |
| Error rate at peak | _TBD_ % |

## Soak Test Stability

> **Note:** Fill in after running the 4-hour soak test.
> Run: `k6 run tests/performance/soak.k6.js -e PERF_TENANT_ID=org_soak_test`

| Metric | Value | Threshold |
|---|---|---|
| p95 at hour 0 | _TBD_ ms | — |
| p95 at hour 1 | _TBD_ ms | ≤ 120% of hour 0 |
| p95 at hour 2 | _TBD_ ms | ≤ 120% of hour 0 |
| p95 at hour 3 | _TBD_ ms | ≤ 120% of hour 0 |
| p95 at hour 4 | _TBD_ ms | ≤ 120% of hour 0 |
| RSS start | _TBD_ MB | — |
| RSS end | _TBD_ MB | ≤ 110% of start |
| Connection pool exhaustion errors | _TBD_ | 0 |
| Detail query p95 (stage history) | _TBD_ ms | ≤ 1500ms |

## Regression Detection Criteria

A performance regression is declared when ANY of the following are true:

1. **p95 regression > 20%** — Any endpoint's p95 exceeds 120% of its
   established baseline value from this document.

2. **Error rate > 0.1%** — Under normal load (25 VUs), the error rate
   exceeds 0.1%.

3. **Memory growth > 10%** — RSS grows more than 10% during a 4-hour
   soak test.

4. **Latency drift > 20%** — p95 at the end of the soak test exceeds
   120% of p95 at the beginning.

## How to Update Baselines

1. Seed the soak database: `pnpm --filter @workspace/scripts run seed-soak-data`
2. Start the API server via the workflow
3. Run the load test: `k6 run tests/performance/load.k6.js -e PERF_TENANT_ID=org_soak_test`
4. Record p50/p95/p99 per endpoint in the table above
5. Run the stress test and record the breaking point
6. Run the soak test and record hourly p95 + RSS
7. Commit the updated baselines
