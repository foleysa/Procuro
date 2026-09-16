import {
  diligenceSectionIds,
  diligenceSectionMeta,
  type DiligenceSectionId,
} from "./diligence";
import {
  pulseDay030EditionTags,
  pulseEditionLabel,
  type PulseDay030EditionTag,
} from "./editions";

export const DILIGENCE_TEMPLATE_SCHEMA_VERSION = 1 as const;

export interface DiligenceTemplateSection {
  id: DiligenceSectionId;
  title: string;
  scope: "horizontal" | "edition" | "governance";
  /** What this section must answer. */
  prompt: string;
  /** Public / licensed inputs we may use without buyer files. */
  publicInputs: string;
  /** Buyer-provided files under a Procuro MSA. */
  buyerInputs: string;
  /** Explicit refusals. */
  doNot: string;
}

export interface DiligencePackTemplate {
  schemaVersion: typeof DILIGENCE_TEMPLATE_SCHEMA_VERSION;
  id: "diligence-template-v1";
  /** Null = horizontal body only; set when attaching an edition appendix. */
  editionTag: PulseDay030EditionTag | null;
}

const SECTION_COPY: Record<
  DiligenceSectionId,
  Pick<DiligenceTemplateSection, "prompt" | "publicInputs" | "buyerInputs" | "doNot">
> = {
  "diligence.exec_summary": {
    prompt:
      "What moved in procurement, supply chain, and logistics that a PE / board / new CPO must see this week — without a savings headline.",
    publicInputs: "Pulse Core Observe citations for the pack window.",
    buyerInputs: "One-paragraph scope from the buyer (entity, window, edition).",
    doNot: "No guaranteed ROI. No “N verticals live.” No FSA war stories.",
  },
  "diligence.spend_shape": {
    prompt:
      "How is spend shaped across suppliers, categories, and contracts? Horizontal, not a niche cut.",
    publicInputs: "None required. Public category taxonomies (UNSPSC / custom map) only.",
    buyerInputs: "Spend extract / ERP-adjacent file drop under Procuro MSA.",
    doNot: "No FSA engagement files. No silent resale of raw identifiable spend.",
  },
  "diligence.supplier_concentration": {
    prompt: "Where is supplier concentration a judgment problem (single-source, site, or spec)?",
    publicInputs: "Public supplier filings / recalls only when cited.",
    buyerInputs: "Supplier master + site/plant map from the buyer.",
    doNot: "No invented HHI or peer rank.",
  },
  "diligence.category_inflation": {
    prompt:
      "Where does buyer unit cost diverge from a named public index (BLS PPI, USDA ERS, FRED series)?",
    publicInputs: "Named series + release date (cite or leave blank).",
    buyerInputs: "Category unit-cost series from the buyer.",
    doNot: "No peer percentile. No unlabeled “market is up X% so you should save Y.”",
  },
  "diligence.logistics_exposure": {
    prompt:
      "What is logistics exposure as a Core lens — modes, lanes, detention, service — not a freight-SKU product.",
    publicInputs: "BLS truck freight PPI, Cass Freight Index, other named public lane series.",
    buyerInputs: "TMS / carrier scorecard opt-in, or a lane list from the buyer.",
    doNot: "Do not rebrand the pack as an ocean-freight tool.",
  },
  "diligence.judgment_opportunities": {
    prompt:
      "Which Decide candidates (renegotiate / dual_source / switch_lane / hold / kill) are in scope?",
    publicInputs: "Pulse suggested Decide from the matching Core issue.",
    buyerInputs: "Buyer confirmation of which candidates they will label.",
    doNot: "Do not claim realized savings without a Layer C Learn of `saved` on this buyer’s opportunities.",
  },
  "diligence.risk_disruption": {
    prompt: "What public disruption / policy Observe items hit this window?",
    publicInputs: "FDA/FSMA-class notices, port/weather/sanctions public items.",
    buyerInputs: "Buyer plant geography and inbound origins.",
    doNot: "No FSA operator notes.",
  },
  "diligence.edition_appendix": {
    prompt:
      "Edition language pack only — MRO storeroom / Food perishability, etc. Same spine.",
    publicInputs: "Edition-tagged Observe from Pulse Core.",
    buyerInputs: "Edition-specific category list from the buyer.",
    doNot: "Do not spin a second brand or a custom snowflake pack type.",
  },
  "diligence.methodology_and_limits": {
    prompt:
      "What is cited, what is unknown, and what is withheld until N policy exists?",
    publicInputs: "Release dates and series IDs used in this pack.",
    buyerInputs: "Window and entity the buyer asked us to cover.",
    doNot: "Below written N: no “peer” language. Unknown is first-class.",
  },
  "diligence.data_fences": {
    prompt: "Restate LoE and data walls.",
    publicInputs: "This template.",
    buyerInputs: "Procuro MSA / DPA — not an FSA SOW.",
    doNot: "Procuro ≠ FSA. No FSA client data without John’s bridge greenlight. No raw identifiable spend resale.",
  },
};

export function diligenceTemplateSections(
  editionTag: PulseDay030EditionTag | null = null,
): DiligenceTemplateSection[] {
  return diligenceSectionIds.map((id) => {
    const meta = diligenceSectionMeta[id];
    const copy = SECTION_COPY[id];
    const editionNote =
      id === "diligence.edition_appendix" && editionTag
        ? ` Attach for ${pulseEditionLabel[editionTag]} (\`${editionTag}\`).`
        : id === "diligence.edition_appendix"
          ? ` Leave the edition blank until the buyer picks ${pulseDay030EditionTags.join(" or ")}.`
          : "";
    return {
      id,
      title: meta.title,
      scope: meta.scope,
      prompt: copy.prompt + editionNote,
      publicInputs: copy.publicInputs,
      buyerInputs: copy.buyerInputs,
      doNot: copy.doNot,
    };
  });
}

export function renderDiligenceTemplate(
  editionTag: PulseDay030EditionTag | null = null,
): string {
  const edition =
    editionTag == null
      ? "horizontal body; edition appendix slot empty until the buyer picks `mro` or `food`"
      : `horizontal body + ${pulseEditionLabel[editionTag]} appendix`;
  const body = diligenceTemplateSections(editionTag)
    .map((section) => {
      return `## \`${section.id}\` — ${section.title}

**Scope:** ${section.scope}

**Must answer:** ${section.prompt}

| Slot | Fill with |
|---|---|
| Public / licensed | ${section.publicInputs} |
| Buyer (Procuro MSA) | ${section.buyerInputs} |
| Do not | ${section.doNot} |

_Answer:_ _(blank until this pack is sold — do not invent figures)_
`;
    })
    .join("\n");

  return `# Diligence Pack template v1

**Id:** \`diligence-template-v1\` · **Schema:** ${DILIGENCE_TEMPLATE_SCHEMA_VERSION}

**LoE:** Procuro data product. Not FSA. Not a suite replacement.

**Shape:** ${edition}

Reusable. One template, edition appendix additive. Buyer-provided files only. Cite public series or leave the answer blank.

${body}## Kill this pack if

- Sales needs a fake peer score or savings % to close.
- The only way to fill a section is FSA client data and John has not greenlit a bridge.
- The appendix is being sold as a standalone niche brand.
`;
}
