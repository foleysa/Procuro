/**
 * Email channel adapter.
 *
 * If `SENDGRID_API_KEY` is set in the environment, posts to
 * `https://api.sendgrid.com/v3/mail/send` using SendGrid's v3 schema.
 * Otherwise records a `simulated` delivery so the rest of the
 * notification pipeline (delivery row, idempotency markers, escalation
 * cancellation) still exercises end-to-end in dev / test / unconfigured
 * production.
 *
 * Configuration shape:
 *   { to: string | string[], from?: string }
 *
 * The default `from` is `notifications@procuro.local` if neither
 * `config.from` nor `EMAIL_FROM` is set.
 */

import type { AlertRow, AlertChannelRow } from "@workspace/db";
import {
  ChannelConfigError,
  type ChannelAdapter,
  type ChannelDeliveryResult,
} from "./types";

interface EmailConfig {
  to: string[];
  from: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function readConfig(config: Record<string, unknown>): EmailConfig {
  const rawTo = config["to"];
  const toList: string[] = Array.isArray(rawTo)
    ? rawTo.filter((x): x is string => typeof x === "string")
    : typeof rawTo === "string"
      ? [rawTo]
      : [];
  if (toList.length === 0) {
    throw new ChannelConfigError(
      "email channel requires `to` (string or string[])",
    );
  }
  for (const addr of toList) {
    if (!EMAIL_RE.test(addr)) {
      throw new ChannelConfigError(
        `email channel: invalid recipient address "${addr}"`,
      );
    }
  }
  const from =
    typeof config["from"] === "string"
      ? (config["from"] as string)
      : (process.env["EMAIL_FROM"] ?? "notifications@procuro.local");
  if (!EMAIL_RE.test(from)) {
    throw new ChannelConfigError(
      `email channel: invalid sender address "${from}"`,
    );
  }
  return { to: toList, from };
}

function renderSubject(alert: AlertRow): string {
  const sev = alert.severity.toUpperCase();
  return `[Procuro][${sev}] ${alert.title}`;
}

function renderTextBody(alert: AlertRow): string {
  const lines = [
    alert.title,
    "".padEnd(alert.title.length, "="),
    "",
    `Severity: ${alert.severity}`,
    `Source:   ${alert.source}`,
    `State:    ${alert.state}`,
    `First seen: ${alert.firstSeenAt.toISOString()}`,
    `Last seen:  ${alert.lastSeenAt.toISOString()}`,
    `Occurrences: ${alert.occurrences}`,
    "",
  ];
  if (alert.summary) {
    lines.push(alert.summary, "");
  }
  lines.push(`Alert ID: ${alert.id}`);
  return lines.join("\n");
}

export const emailChannelAdapter: ChannelAdapter = {
  kind: "email",
  validateConfig(config) {
    readConfig(config);
  },
  async send({
    alert,
    channel,
  }: {
    alert: AlertRow;
    channel: AlertChannelRow;
  }): Promise<ChannelDeliveryResult> {
    const cfg = readConfig(channel.config as Record<string, unknown>);
    const subject = renderSubject(alert);
    const text = renderTextBody(alert);
    const apiKey = process.env["SENDGRID_API_KEY"];

    if (!apiKey) {
      return {
        status: "simulated",
        payload: {
          to: cfg.to,
          from: cfg.from,
          subject,
          textPreview: text.slice(0, 200),
          reason: "SENDGRID_API_KEY not set; delivery simulated",
        },
      };
    }

    const body = {
      personalizations: [{ to: cfg.to.map((email) => ({ email })) }],
      from: { email: cfg.from },
      subject,
      content: [{ type: "text/plain", value: text }],
    };

    let res: Response;
    try {
      res = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      return {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        payload: { to: cfg.to, from: cfg.from, subject },
      };
    }

    if (res.status >= 200 && res.status < 300) {
      const messageId = res.headers.get("x-message-id") ?? undefined;
      return {
        status: "delivered",
        httpStatus: res.status,
        providerMessageId: messageId,
        payload: { to: cfg.to, from: cfg.from, subject },
      };
    }
    let errBody = "";
    try {
      errBody = (await res.text()).slice(0, 500);
    } catch {
      /* ignore */
    }
    return {
      status: "failed",
      httpStatus: res.status,
      error: `sendgrid HTTP ${res.status}: ${errBody}`,
      payload: { to: cfg.to, from: cfg.from, subject },
    };
  },
};
