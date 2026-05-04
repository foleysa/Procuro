/**
 * k6 Load Test — Normal expected traffic simulation.
 *
 * Simulates 25 concurrent users for 5 minutes against the four critical
 * API endpoints. Validates p95 response times and error rates.
 *
 * Run:
 *   k6 run tests/performance/load.k6.js \
 *     -e BASE_URL=http://localhost:80 \
 *     -e API_TOKEN=<token> \
 *     -e TENANT_ID=org_soak_test
 *
 * Environment variables:
 *   PERF_BASE_URL   — API base (default: http://localhost:80)
 *   PERF_API_TOKEN  — Bearer token for auth
 *   PERF_TENANT_ID  — Tenant org ID (default: org_soak_test)
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Rate } from "k6/metrics";

// ---------------------------------------------------------------------------
// Custom metrics per endpoint group
// ---------------------------------------------------------------------------
const feedLatency = new Trend("latency_today_feed", true);
const oppListLatency = new Trend("latency_opp_list", true);
const oppDetailLatency = new Trend("latency_opp_detail", true);
const gateSummaryLatency = new Trend("latency_gate_summary", true);
const errorRate = new Rate("errors");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const BASE_URL = __ENV.PERF_BASE_URL || __ENV.BASE_URL || "http://localhost:80";
const API_TOKEN = __ENV.PERF_API_TOKEN || __ENV.API_TOKEN || "";
const TENANT_ID =
  __ENV.PERF_TENANT_ID || __ENV.TENANT_ID || "org_soak_test";

export const options = {
  stages: [
    { duration: "2m30s", target: 25 },
    { duration: "5m", target: 25 },
    { duration: "1m", target: 0 },
  ],
  thresholds: {
    http_req_duration: ["p(95)<1500"],
    errors: ["rate<0.001"],
    latency_today_feed: ["p(95)<1500"],
    latency_opp_list: ["p(95)<1500"],
    latency_opp_detail: ["p(95)<1500"],
    latency_gate_summary: ["p(95)<1500"],
  },
};

function headers() {
  const h = {
    "Content-Type": "application/json",
    "x-org-id": TENANT_ID,
  };
  if (API_TOKEN) {
    h["Authorization"] = `Bearer ${API_TOKEN}`;
  }
  return h;
}

// Cached opportunity IDs from the list endpoint for detail lookups
let cachedOppIds = [];

export default function () {
  const params = { headers: headers(), tags: {} };

  // 1. Dashboard feed
  {
    params.tags = { endpoint: "today_feed" };
    const res = http.get(`${BASE_URL}/api/today/feed`, params);
    feedLatency.add(res.timings.duration);
    const ok = check(res, {
      "feed status 200": (r) => r.status === 200,
    });
    errorRate.add(!ok);
  }

  sleep(0.5);

  // 2. Paginated opportunity list
  {
    params.tags = { endpoint: "opp_list" };
    const res = http.get(
      `${BASE_URL}/api/opportunities?limit=50&canonicalStage=Identified`,
      params,
    );
    oppListLatency.add(res.timings.duration);
    const ok = check(res, {
      "opp list status 200": (r) => r.status === 200,
    });
    errorRate.add(!ok);

    // Cache some IDs for detail lookups
    if (res.status === 200) {
      try {
        const body = JSON.parse(res.body);
        if (body.items && body.items.length > 0) {
          cachedOppIds = body.items
            .slice(0, 10)
            .map((item) => item.id);
        }
      } catch (_) {
        // ignore parse failures
      }
    }
  }

  sleep(0.5);

  // 3. Opportunity detail (with embedded stage history)
  if (cachedOppIds.length > 0) {
    params.tags = { endpoint: "opp_detail" };
    const oppId =
      cachedOppIds[Math.floor(Math.random() * cachedOppIds.length)];
    const res = http.get(
      `${BASE_URL}/api/opportunities/${oppId}`,
      params,
    );
    oppDetailLatency.add(res.timings.duration);
    const ok = check(res, {
      "opp detail status 200": (r) => r.status === 200,
    });
    errorRate.add(!ok);
  }

  sleep(0.5);

  // 4. Gate summary (pipeline visualization)
  {
    params.tags = { endpoint: "gate_summary" };
    const res = http.get(
      `${BASE_URL}/api/opportunities/gate-summary`,
      params,
    );
    gateSummaryLatency.add(res.timings.duration);
    const ok = check(res, {
      "gate summary status 200": (r) => r.status === 200,
    });
    errorRate.add(!ok);
  }

  sleep(1);
}
