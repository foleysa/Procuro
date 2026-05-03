/**
 * Microsoft Teams channel adapter (stub).
 *
 * Posts a MessageCard to a Teams incoming-webhook URL when configured.
 * Same simulated-fallback semantics as the Slack adapter so the
 * pipeline remains exercisable without an external dependency.
 */

import type { AlertRow, AlertChannelRow } from "@workspace/db";
import { assertSafeUrl, assertSafeUrlResolved, SsrfBlockedError } from "../../ssrf-guard";
import {
  ChannelConfigError,
  type ChannelAdapter,
  type ChannelDeliveryResult,
} from "./types";

interface TeamsConfig {
  webhookUrl: string;
}

function readConfig(config: Record<string, unknown>): TeamsConfig {
  const url = config["webhookUrl"];
  if (typeof url !== "string" || !/^https:\/\//i.test(url)) {
    throw new ChannelConfigError(
      "teams channel requires `webhookUrl` (HTTPS URL)",
    );
  }
  try {
    assertSafeUrl(url, { requireHttps: true });
  } catch (err) {
    throw new ChannelConfigError(
      err instanceof SsrfBlockedError
        ? `teams webhookUrl rejected: ${err.message}`
        : "teams webhookUrl is not allowed",
    );
  }
  return { webhookUrl: url };
}

const SEVERITY_THEME: Record<string, string> = {
  info: "0078D4",
  low: "00A2AD",
  medium: "F1C232",
  high: "E07B00",
  critical: "C00000",
};

export const teamsChannelAdapter: ChannelAdapter = {
  kind: "teams",
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
    const card = {
      "@type": "MessageCard",
      "@context": "https://schema.org/extensions",
      themeColor: SEVERITY_THEME[alert.severity] ?? "808080",
      summary: alert.title,
      title: `[${alert.severity.toUpperCase()}] ${alert.title}`,
      text: alert.summary || "",
      sections: [
        {
          facts: [
            { name: "Source", value: alert.source },
            { name: "State", value: alert.state },
            { name: "Occurrences", value: String(alert.occurrences) },
            { name: "Alert ID", value: alert.id },
          ],
        },
      ],
    };
    // DNS-resolution SSRF check: verify the destination hostname resolves
    // only to public IP ranges. This catches DNS-indirection bypasses
    // (e.g. attacker-controlled hostnames pointing to 10.x / 169.254.x)
    // that the synchronous schema-validation check cannot detect.
    try {
      await assertSafeUrlResolved(cfg.webhookUrl, { requireHttps: true });
    } catch (err) {
      return {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        payload: { title: card.title },
      };
    }

    let res: Response;
    try {
      res = await fetch(cfg.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(card),
        // Disable redirect-following so a public URL cannot redirect the
        // backend to an internal address (redirect-based SSRF bypass).
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      return {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        payload: { title: card.title },
      };
    }
    const ok = res.status >= 200 && res.status < 300;
    return {
      status: ok ? "delivered" : "failed",
      httpStatus: res.status,
      error: ok ? undefined : `teams returned HTTP ${res.status}`,
      payload: { title: card.title },
    };
  },
};
