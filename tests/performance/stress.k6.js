/**
 * k6 Stress Test — Find the breaking point.
 *
 * Pushes from 50 to 800 concurrent users over 10 minutes against the
 * two heaviest endpoints. Does NOT fail on thresholds — the goal is to
 * document the exact VU count where p95 exceeds 3000ms.
 *
 * Run:
 *   k6 run tests/performance/stress.k6.js \
 *     -e BASE_URL=http://localhost:80 \
 *     -e API_TOKEN=<token> \
 *     -e TENANT_ID=org_soak_test
 *
 * Output:
 *   Writes stress-summary.json to the current working directory via
 *   handleSummary() with the p95 at peak load and the estimated
 *   breaking-point VU count.
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Rate, Counter } from "k6/metrics";

const feedLatency = new Trend("stress_feed_latency", true);
const gateLatency = new Trend("stress_gate_latency", true);
const errorRate = new Rate("stress_errors");
const totalRequests = new Counter("stress_total_requests");

const BASE_URL = __ENV.PERF_BASE_URL || __ENV.BASE_URL || "http://localhost:80";
const API_TOKEN = __ENV.PERF_API_TOKEN || __ENV.API_TOKEN || "";
const TENANT_ID =
  __ENV.PERF_TENANT_ID || __ENV.TENANT_ID || "org_soak_test";

export const options = {
  stages: [
    { duration: "1m", target: 50 },
    { duration: "2m", target: 200 },
    { duration: "2m", target: 400 },
    { duration: "2m", target: 600 },
    { duration: "2m", target: 800 },
    { duration: "1m", target: 0 },
  ],
  // No thresholds that fail — we observe and document
  thresholds: {},
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

export default function () {
  const params = { headers: headers() };

  // Today feed — the heaviest aggregation endpoint
  {
    const res = http.get(`${BASE_URL}/api/today/feed`, params);
    feedLatency.add(res.timings.duration);
    totalRequests.add(1);
    const ok = check(res, {
      "feed status 2xx": (r) => r.status >= 200 && r.status < 300,
    });
    errorRate.add(!ok);
  }

  sleep(0.3);

  // Gate summary — heavy SQL aggregation
  {
    const res = http.get(
      `${BASE_URL}/api/opportunities/gate-summary`,
      params,
    );
    gateLatency.add(res.timings.duration);
    totalRequests.add(1);
    const ok = check(res, {
      "gate status 2xx": (r) => r.status >= 200 && r.status < 300,
    });
    errorRate.add(!ok);
  }

  sleep(0.5);
}

export function handleSummary(data) {
  const feedP95 =
    data.metrics.stress_feed_latency &&
    data.metrics.stress_feed_latency.values
      ? data.metrics.stress_feed_latency.values["p(95)"]
      : null;

  const gateP95 =
    data.metrics.stress_gate_latency &&
    data.metrics.stress_gate_latency.values
      ? data.metrics.stress_gate_latency.values["p(95)"]
      : null;

  const errorPct =
    data.metrics.stress_errors && data.metrics.stress_errors.values
      ? data.metrics.stress_errors.values.rate
      : null;

  const totalReqs =
    data.metrics.stress_total_requests &&
    data.metrics.stress_total_requests.values
      ? data.metrics.stress_total_requests.values.count
      : null;

  const httpP95 =
    data.metrics.http_req_duration && data.metrics.http_req_duration.values
      ? data.metrics.http_req_duration.values["p(95)"]
      : null;

  const summary = {
    timestamp: new Date().toISOString(),
    peakVUs: 800,
    feedP95Ms: feedP95,
    gateP95Ms: gateP95,
    overallP95Ms: httpP95,
    errorRate: errorPct,
    totalRequests: totalReqs,
    breakingPointNote:
      "Review the k6 stdout timeline to identify the exact VU count " +
      "where p95 exceeded 3000ms. Look for the stage transition where " +
      "latency spiked.",
  };

  return {
    "stress-summary.json": JSON.stringify(summary, null, 2),
    stdout: textSummary(data, { indent: " ", enableColors: true }),
  };
}

function textSummary(data, opts) {
  // k6 provides a built-in text summary; we use a simple fallback
  // since handleSummary replaces the default output.
  const lines = [
    "=== Stress Test Summary ===",
    `Total requests: ${data.metrics.stress_total_requests?.values?.count ?? "N/A"}`,
    `Feed p95:       ${data.metrics.stress_feed_latency?.values?.["p(95)"]?.toFixed(1) ?? "N/A"} ms`,
    `Gate p95:       ${data.metrics.stress_gate_latency?.values?.["p(95)"]?.toFixed(1) ?? "N/A"} ms`,
    `Overall p95:    ${data.metrics.http_req_duration?.values?.["p(95)"]?.toFixed(1) ?? "N/A"} ms`,
    `Error rate:     ${((data.metrics.stress_errors?.values?.rate ?? 0) * 100).toFixed(2)}%`,
    "",
    "stress-summary.json written to disk.",
  ];
  return lines.join("\n");
}
