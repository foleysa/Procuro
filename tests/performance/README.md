# Performance Tests

Three k6 scenarios for load, stress, and soak testing of the Procuro API server.

## Prerequisites

1. **k6** — Install via your platform package manager or from https://k6.io/docs/get-started/installation/
2. **Seeded database** — The soak test requires 50K opportunities. Seed with:
   ```bash
   pnpm --filter @workspace/scripts run seed-soak-data
   ```
3. **Running API server** — Start via the workflow or:
   ```bash
   # Use the workflow system; do not run pnpm dev at root
   ```

## Environment Variables

All three scenarios accept these environment variables:

| Variable | Default | Description |
|---|---|---|
| `PERF_BASE_URL` | `http://localhost:80` | API base URL (through proxy) |
| `PERF_API_TOKEN` | (empty) | Bearer token for authentication |
| `PERF_TENANT_ID` | `org_soak_test` | Tenant org ID |

## Scenarios

### Load Test

Simulates normal expected traffic — 25 concurrent users for 5 minutes.

```bash
k6 run tests/performance/load.k6.js \
  -e PERF_BASE_URL=http://localhost:80 \
  -e PERF_TENANT_ID=org_soak_test
```

**Endpoints tested:**
- `GET /api/today/feed` (dashboard aggregation)
- `GET /api/opportunities?limit=50&canonicalStage=Identified` (paginated list)
- `GET /api/opportunities/:id` (detail with stage history)
- `GET /api/opportunities/gate-summary` (pipeline visualization)

**Pass/fail gates:**
- p95 response time ≤ 1500ms (global and per-endpoint)
- Error rate < 0.1%

### Stress Test

Pushes from 50 to 800 concurrent users to find the breaking point.

```bash
k6 run tests/performance/stress.k6.js \
  -e PERF_BASE_URL=http://localhost:80 \
  -e PERF_TENANT_ID=org_soak_test
```

**Endpoints tested:**
- `GET /api/today/feed`
- `GET /api/opportunities/gate-summary`

**Output:**
- No pass/fail thresholds — this is an observation test
- Writes `stress-summary.json` with p95 at peak load
- Review k6 stdout to identify the VU count where p95 > 3000ms

### Soak Test

Sustained load for 4 hours against a database seeded with 12 months of data.

```bash
k6 run tests/performance/soak.k6.js \
  -e PERF_BASE_URL=http://localhost:80 \
  -e PERF_TENANT_ID=org_soak_test
```

**Endpoints tested:**
- `GET /api/today/feed`
- `GET /api/opportunities?limit=<random>&canonicalStage=<random>`
- `GET /api/opportunities/:id`

**Pass/fail gates:**
- p95 < 2000ms overall
- Error rate < 0.5%
- Detail query p95 < 1500ms

**Post-run manual checks:**
- API server RSS memory growth ≤ 10% (compare start vs end)
- No connection pool exhaustion errors in server logs
- p95 latency stable within 20% across the run duration

## What To Do When a Test Fails

| Failure | Action |
|---|---|
| **Load test p95 > 1500ms** | Profile the slow endpoint. Check for missing indexes, N+1 queries, or expensive aggregations. Log the baseline and open a follow-up ticket. |
| **Stress test degrades early** | Document the breaking point VU count. Consider connection pooling limits (`PG_POOL_MAX`), Express concurrency, or query optimization. |
| **Soak test memory growth > 10%** | Likely a memory leak — check for unbounded caches, event listener accumulation, or connection handle leaks. Profile with `--inspect` and heap snapshots. |
| **Soak test latency drift > 20%** | Check for table bloat, missing VACUUM, or index degradation. Run `EXPLAIN ANALYZE` on the degrading query. |
| **Connection pool exhaustion** | Increase `PG_POOL_MAX` or audit for connection leaks (unclosed transactions, missing `.release()` calls). |
