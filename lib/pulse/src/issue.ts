import { leverIds, marketSignalTypes } from "@workspace/db/schema";
import {
  pulseCoreCadences,
  type PulseCoreCadence,
  type PulseCoreIssue,
  type PulseCoreObserveItem,
  type PulseSuggestedDecide,
} from "./align";
import { isPulseDecideAction } from "./decide";
import {
  isPulseDay030EditionTag,
  isPulseEditionTag,
  type PulseDay030EditionTag,
} from "./editions";
import { isPulseObserveKind } from "./observe";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const LEVER_SET = new Set<string>(leverIds);
const SIGNAL_TYPE_SET = new Set<string>(marketSignalTypes);

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(ms);
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return null;
  }
  return value;
}

function parseObserveItem(input: unknown): PulseCoreObserveItem | null {
  if (input == null || typeof input !== "object") return null;
  const row = input as Record<string, unknown>;
  if (typeof row.kind !== "string" || !isPulseObserveKind(row.kind)) {
    return null;
  }
  if (!Array.isArray(row.verticalTags) || row.verticalTags.length === 0) {
    return null;
  }
  if (
    !row.verticalTags.every(
      (tag) => typeof tag === "string" && isPulseEditionTag(tag),
    )
  ) {
    return null;
  }
  if (typeof row.sourceLabel !== "string" || row.sourceLabel.length === 0) {
    return null;
  }
  if (typeof row.summary !== "string" || row.summary.length === 0) return null;
  if (row.sourceUrl != null && typeof row.sourceUrl !== "string") return null;
  if (row.marketSignalId != null && typeof row.marketSignalId !== "string") {
    return null;
  }
  if (
    row.marketSignalType != null &&
    (typeof row.marketSignalType !== "string" ||
      !SIGNAL_TYPE_SET.has(row.marketSignalType))
  ) {
    return null;
  }
  return {
    kind: row.kind,
    verticalTags: row.verticalTags,
    sourceLabel: row.sourceLabel,
    summary: row.summary,
    ...(typeof row.sourceUrl === "string" ? { sourceUrl: row.sourceUrl } : {}),
    ...(typeof row.marketSignalType === "string"
      ? { marketSignalType: row.marketSignalType }
      : {}),
    ...(typeof row.marketSignalId === "string"
      ? { marketSignalId: row.marketSignalId }
      : {}),
  } as PulseCoreObserveItem;
}

function parseSuggestedDecide(input: unknown): PulseSuggestedDecide | null {
  if (input == null || typeof input !== "object") return null;
  const row = input as Record<string, unknown>;
  if (
    typeof row.decideAction !== "string" ||
    !isPulseDecideAction(row.decideAction)
  ) {
    return null;
  }
  if (!Array.isArray(row.verticalTags) || row.verticalTags.length === 0) {
    return null;
  }
  if (
    !row.verticalTags.every(
      (tag) => typeof tag === "string" && isPulseEditionTag(tag),
    )
  ) {
    return null;
  }
  if (typeof row.prompt !== "string" || row.prompt.length === 0) return null;
  if (
    row.leverId != null &&
    (typeof row.leverId !== "string" || !LEVER_SET.has(row.leverId))
  ) {
    return null;
  }
  return {
    decideAction: row.decideAction,
    verticalTags: row.verticalTags,
    prompt: row.prompt,
    ...(typeof row.leverId === "string" ? { leverId: row.leverId } : {}),
  } as PulseSuggestedDecide;
}

/**
 * Validate a Pulse Core issue stub. Learn outcomes are rejected — they
 * must not appear on an issue until aggregation rules exist.
 */
export function parsePulseCoreIssue(input: unknown): PulseCoreIssue | null {
  if (input == null || typeof input !== "object") return null;
  const row = input as Record<string, unknown>;
  if (row.schemaVersion !== 1) return null;
  if (typeof row.id !== "string" || !row.id.startsWith("pulse-")) return null;
  if (typeof row.title !== "string" || row.title.length === 0) return null;
  if (typeof row.publishedOn !== "string" || !isIsoDate(row.publishedOn)) {
    return null;
  }
  if (
    typeof row.cadence !== "string" ||
    !(pulseCoreCadences as readonly string[]).includes(row.cadence)
  ) {
    return null;
  }
  if (!Array.isArray(row.editionTags) || row.editionTags.length === 0) {
    return null;
  }
  if (
    !row.editionTags.every(
      (tag) => typeof tag === "string" && isPulseDay030EditionTag(tag),
    )
  ) {
    return null;
  }
  if ("learn" in row || "learnOutcomes" in row) return null;
  if (!Array.isArray(row.observe) || row.observe.length === 0) return null;
  const observe = row.observe.map(parseObserveItem);
  if (observe.some((item) => item == null)) return null;
  const questions = asStringArray(row.orientQuestions);
  if (questions == null || questions.length === 0) return null;
  if (!Array.isArray(row.suggestedDecides) || row.suggestedDecides.length === 0) {
    return null;
  }
  const suggested = row.suggestedDecides.map(parseSuggestedDecide);
  if (suggested.some((item) => item == null)) return null;

  return {
    schemaVersion: 1,
    id: row.id,
    title: row.title,
    publishedOn: row.publishedOn,
    cadence: row.cadence as PulseCoreCadence,
    editionTags: row.editionTags as PulseDay030EditionTag[],
    observe: observe as PulseCoreObserveItem[],
    orientQuestions: questions,
    suggestedDecides: suggested as PulseSuggestedDecide[],
  };
}
