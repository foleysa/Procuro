import type { PulseCoreIssue } from "./align";
import { pulseEditionLabel, type PulseEditionTag } from "./editions";

function cite(item: PulseCoreIssue["observe"][number]): string {
  return item.sourceUrl
    ? `[${item.sourceLabel}](${item.sourceUrl})`
    : item.sourceLabel;
}

function itemsFor(
  issue: PulseCoreIssue,
  tag: PulseEditionTag,
): PulseCoreIssue["observe"] {
  return issue.observe.filter((item) => item.verticalTags.includes(tag));
}

function decidesFor(
  issue: PulseCoreIssue,
  tag: PulseEditionTag,
): PulseCoreIssue["suggestedDecides"] {
  return issue.suggestedDecides.filter((item) =>
    item.verticalTags.includes(tag),
  );
}

function renderObserveList(
  items: PulseCoreIssue["observe"],
): string {
  return items
    .map((item) => `- **${item.kind}** — ${item.summary} Source: ${cite(item)}.`)
    .join("\n");
}

function renderDecideList(
  items: PulseCoreIssue["suggestedDecides"],
): string {
  return items
    .map((item) => {
      const lever = item.leverId ? ` · lever \`${item.leverId}\`` : "";
      return `- **${item.decideAction}**${lever} — ${item.prompt}`;
    })
    .join("\n");
}

/**
 * Operator-forwardable markdown for a Pulse Core issue.
 * Learn is omitted on purpose.
 */
export function renderPulseCoreIssue(issue: PulseCoreIssue): string {
  const editionLine = issue.editionTags
    .map((tag) => `${pulseEditionLabel[tag]} (\`${tag}\`)`)
    .join(", ");
  const questions = issue.orientQuestions.map((q) => `- ${q}`).join("\n");
  const coreObserve = issue.observe.filter((item) =>
    item.verticalTags.includes("logistics"),
  );
  const chapters = issue.editionTags
    .map((tag) => {
      const observe = itemsFor(issue, tag);
      const decides = decidesFor(issue, tag);
      return `## Edition chapter — ${pulseEditionLabel[tag]} (\`${tag}\`)

Lens on the same desk. Not a separate product.

### Observe
${renderObserveList(observe)}

### Suggested Decide
${renderDecideList(decides)}
`;
    })
    .join("\n");

  return `# ${issue.title}

**Issue id:** \`${issue.id}\` · **Dated:** ${issue.publishedOn} · **Cadence:** ${issue.cadence}

**LoE:** Procuro Pulse (SaaS / data product) — not FSA, not the Weekly Brief.

**Packaging:** Pulse Core (procurement + supply chain + logistics) with edition chapters: ${editionLine}. Logistics is a Core lens, not a third company.

**Fences:** Public citations only. No tenant spend, no FSA client files, no invented ARR / savings % / peer percentiles. Suggested Decide actions are candidates — not labeled Layer C until an operator records them. Learn is withheld until aggregation rules exist.

## Observe — Core (logistics lens)

${renderObserveList(coreObserve)}

## Orient questions

${questions}

## Suggested Decide — Core

${renderDecideList(decidesFor(issue, "logistics"))}

${chapters}
## What this issue does not claim

- It does not say Pulse has N subscribers, N verticals live, or a savings rate.
- It does not publish desk Learn outcomes.
- It does not treat Cass or BLS as your plant’s rate card.
- Edition chapters are skins. The product remains one judgment desk.
`;
}
