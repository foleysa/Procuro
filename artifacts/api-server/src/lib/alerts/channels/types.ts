/**
 * Channel adapter contract.
 *
 * One adapter per channel kind. Each adapter is responsible for:
 *   - converting an alert + channel config into an outbound payload
 *   - performing the network call (or simulating it)
 *   - returning a `ChannelDeliveryResult` describing what happened
 *
 * Adapters NEVER throw on logical "delivery failed" outcomes — they
 * return `{ status: "failed", error }` so the worker can decide
 * whether to retry. They MAY throw on programmer error
 * (misconfigured input, missing required field) — those propagate
 * as job failures and are surfaced in the job UI.
 */

import type { AlertRow, AlertChannelRow } from "@workspace/db";

export interface ChannelDeliveryResult {
  status: "delivered" | "failed" | "simulated" | "skipped";
  /** Provider-side message id when available (e.g. SendGrid x-message-id). */
  providerMessageId?: string;
  /**
   * Free-form snapshot of what was actually sent. Stored on
   * `alert_deliveries.payload` for forensic / debugging purposes;
   * stripped of any secret material (no API keys, no full bearer
   * tokens — only their HMAC signatures are kept).
   */
  payload?: Record<string, unknown>;
  /** When `status === "failed"`: human-readable error. */
  error?: string;
  /** Optional HTTP-style status code surfaced to operators. */
  httpStatus?: number;
}

export interface ChannelAdapter {
  kind: AlertChannelRow["kind"];
  /**
   * Validate `channel.config` and throw a `TypeError` if it's missing
   * required fields. Called eagerly when a channel is created via the
   * REST API so operators see the error inline instead of finding out
   * the first time an alert fires.
   */
  validateConfig(config: Record<string, unknown>): void;
  send(args: {
    alert: AlertRow;
    channel: AlertChannelRow;
  }): Promise<ChannelDeliveryResult>;
}

export class ChannelConfigError extends TypeError {}
