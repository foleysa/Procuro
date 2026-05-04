/**
 * k6 Soak Test — Sustained load for 4 hours.
 *
 * Runs 25 constant VUs against the dashboard feed, paginated opportunity
 * list (randomized offsets), and opportunity detail (which includes the
 * stage history query). Designed to detect memory leaks, connection pool
 * exhaustion, and query degradation over time.
 *
 * Prerequisites:
 *   Database must be seeded with soak data:
 *     pnpm --filter @workspace/scripts run seed-soak-data
 *
 * Run:
 *   k6 run tests/performance/soak.k6.js \
 *     -e BASE_URL=http://localhost:80 \
 *     -e API_TOKEN=<token> \
 *     -e TENANT_ID=org_soak_test
 *
 * Pass criteria:
 *   - p95 < 2000ms overall
 *   - Error rate < 0.5%
 *   - Detail queries (with stage history) p95 < 1500ms
 *   - Latency must remain stable within 20% over the 4-hour run
 *     (monitor via k6 Cloud or Grafana; not enforceable in thresholds)
 *
 * Post-run checks (manual):
 *   - RSS growth of the API server process should be ≤ 10%
 *   - No "connection pool exhausted" errors in server logs
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Rate } from "k6/metrics";

const feedLatency = new Trend("soak_feed_latency", true);
const oppListLatency = new Trend("soak_opp_list_latency", true);
const oppDetailLatency = new Trend("soak_opp_detail_latency", true);
const errorRate = new Rate("soak_errors");

const BASE_URL = __ENV.PERF_BASE_URL || __ENV.BASE_URL || "http://localhost:80";
const API_TOKEN = __ENV.PERF_API_TOKEN || __ENV.API_TOKEN || "";
const TENANT_ID =
  __ENV.PERF_TENANT_ID || __ENV.TENANT_ID || "org_soak_test";

export const options = {
  stages: [
    { duration: "5m", target: 25 },
    { duration: "3h50m", target: 25 },
    { duration: "5m", target: 0 },
  ],
  thresholds: {
    http_req_duration: ["p(95)<2000"],
    soak_errors: ["rate<0.005"],
    soak_opp_detail_latency: ["p(95)<1500"],
    soak_feed_latency: ["p(95)<2000"],
    soak_opp_list_latency: ["p(95)<2000"],
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

const STAGES = [
  "Identified",
  "Awarded",
  "In+Implementation",
  "Realized",
  "Closed-No+Action",
];

let cachedOppIds = [];

export default function () {
  const params = { headers: headers() };

  // 1. Dashboard feed
  {
    const res = http.get(`${BASE_URL}/api/today/feed`, params);
    feedLatency.add(res.timings.duration);
    const ok = check(res, {
      "feed 200": (r) => r.status === 200,
    });
    errorRate.add(!ok);
  }

  sleep(1);

  // 2. Paginated opportunity list with randomized filters
  {
    const stage = STAGES[Math.floor(Math.random() * STAGES.length)];
    const limit = [25, 50, 100][Math.floor(Math.random() * 3)];
    const res = http.get(
      `${BASE_URL}/api/opportunities?limit=${limit}&canonicalStage=${stage}`,
      params,
    );
    oppListLatency.add(res.timings.duration);
    const ok = check(res, {
      "opp list 200": (r) => r.status === 200,
    });
    errorRate.add(!ok);

    if (res.status === 200) {
      try {
        const body = JSON.parse(res.body);
        if (body.items && body.items.length > 0) {
          cachedOppIds = body.items
            .slice(0, 20)
            .map((item) => item.id);
        }
      } catch (_) {
        // ignore
      }
    }
  }

  sleep(1);

  // 3. Opportunity detail (includes stage history join)
  if (cachedOppIds.length > 0) {
    const oppId =
      cachedOppIds[Math.floor(Math.random() * cachedOppIds.length)];
    const res = http.get(
      `${BASE_URL}/api/opportunities/${oppId}`,
      params,
    );
    oppDetailLatency.add(res.timings.duration);
    const ok = check(res, {
      "opp detail 200": (r) => r.status === 200,
    });
    errorRate.add(!ok);
  }

  sleep(2);
}
