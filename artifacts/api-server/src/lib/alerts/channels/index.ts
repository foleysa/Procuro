/**
 * Channel registry. Resolves an `AlertChannelRow.kind` to its
 * adapter. Centralised so REST endpoints can validate config eagerly
 * and the delivery worker can dispatch without a switch statement.
 */

import type { AlertChannelRow } from "@workspace/db";
import type { ChannelAdapter } from "./types";
import { emailChannelAdapter } from "./email";
import { webhookChannelAdapter } from "./webhook";
import { slackChannelAdapter } from "./slack";
import { teamsChannelAdapter } from "./teams";

const REGISTRY = new Map<AlertChannelRow["kind"], ChannelAdapter>([
  ["email", emailChannelAdapter],
  ["webhook", webhookChannelAdapter],
  ["slack", slackChannelAdapter],
  ["teams", teamsChannelAdapter],
]);

export function getChannelAdapter(
  kind: AlertChannelRow["kind"],
): ChannelAdapter {
  const adapter = REGISTRY.get(kind);
  if (!adapter) {
    throw new TypeError(`unknown channel kind: ${kind}`);
  }
  return adapter;
}

export function listChannelKinds(): AlertChannelRow["kind"][] {
  return Array.from(REGISTRY.keys());
}

export {
  emailChannelAdapter,
  webhookChannelAdapter,
  slackChannelAdapter,
  teamsChannelAdapter,
};
export type { ChannelAdapter, ChannelDeliveryResult } from "./types";
export { ChannelConfigError } from "./types";
export {
  buildWebhookEnvelope,
  verifyWebhookSignature,
} from "./webhook";
