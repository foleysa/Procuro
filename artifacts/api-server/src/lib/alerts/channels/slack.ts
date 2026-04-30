/**
 * Slack channel adapter (stub).
 *
 * Posts to a Slack incoming-webhook URL when configured. Kept minimal
 * because the production rollout treats Slack as best-effort: if the
 * webhook isn't configured we record a `simulated` delivery rather
 * than throwing, so the rest of the alert pipeline still exercises.
 */

import type { AlertRow, AlertChannelRow } from "@workspace/db";
import {
  ChannelConfigError,
  type ChannelAdapter,
  type ChannelDeliveryResult,
} from "./types";

interface SlackConfig {
  webhookUrl: string;
}

function readConfig(config: Record<string, unknown>): SlackConfig {
  const url = config["webhookUrl"];
  if (typeof url !== "string" || !/^https:\/\/hooks\.slack\.com\//i.test(url)) {
    throw new ChannelConfigError(
      "slack channel requires `webhookUrl` (https://hooks.slack.com/...)",
    );
  }
  return { webhookUrl: url };
}

const SEVERITY_EMOJI: Record<string, string> = {
  info: ":information_source:",
  low: ":small_blue_diamond:",
  medium: ":warning:",
  high: ":rotating_light:",
  critical: ":fire:",
};

export const slackChannelAdapter: ChannelAdapter = {
  kind: "slack",
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
    const emoji = SEVERITY_EMOJI[alert.severity] ?? ":bell:";
    const text =
      `${emoji} *[${alert.severity.toUpperCase()}] ${alert.title}*\n` +
      (alert.summary ? `${alert.summary}\n` : "") +
      `_source:_ \`${alert.source}\`  |  _occurrences:_ ${alert.occurrences}  |  _id:_ \`${alert.id}\``;

    let res: Response;
    try {
      res = await fetch(cfg.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      return {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        payload: { textPreview: text.slice(0, 200) },
      };
    }
    const ok = res.status >= 200 && res.status < 300;
    return {
      status: ok ? "delivered" : "failed",
      httpStatus: res.status,
      error: ok ? undefined : `slack returned HTTP ${res.status}`,
      payload: { textPreview: text.slice(0, 200) },
    };
  },
};
