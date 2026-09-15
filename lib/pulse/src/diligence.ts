/**
 * Diligence Pack section IDs — horizontal template + edition appendix.
 *
 * Reusable across editions. An edition pack is this template plus
 * `diligence.edition_appendix`, not a custom snowflake.
 *
 * No section implies live peer percentiles, savings guarantees, or
 * FSA client evidence.
 */
export const diligenceSectionIds = [
  "diligence.exec_summary",
  "diligence.spend_shape",
  "diligence.supplier_concentration",
  "diligence.category_inflation",
  "diligence.logistics_exposure",
  "diligence.judgment_opportunities",
  "diligence.risk_disruption",
  "diligence.edition_appendix",
  "diligence.methodology_and_limits",
  "diligence.data_fences",
] as const;
export type DiligenceSectionId = (typeof diligenceSectionIds)[number];

const SECTION_SET = new Set<string>(diligenceSectionIds);

export function isDiligenceSectionId(
  value: string,
): value is DiligenceSectionId {
  return SECTION_SET.has(value);
}

export const diligenceSectionMeta: Record<
  DiligenceSectionId,
  { title: string; scope: "horizontal" | "edition" | "governance" }
> = {
  "diligence.exec_summary": {
    title: "Executive summary",
    scope: "horizontal",
  },
  "diligence.spend_shape": {
    title: "Spend, suppliers, contracts",
    scope: "horizontal",
  },
  "diligence.supplier_concentration": {
    title: "Supplier concentration",
    scope: "horizontal",
  },
  "diligence.category_inflation": {
    title: "Category inflation vs public index",
    scope: "horizontal",
  },
  "diligence.logistics_exposure": {
    title: "Logistics exposure (core lens)",
    scope: "horizontal",
  },
  "diligence.judgment_opportunities": {
    title: "Judgment opportunities (Decide candidates)",
    scope: "horizontal",
  },
  "diligence.risk_disruption": {
    title: "Disruption and policy Observe",
    scope: "horizontal",
  },
  "diligence.edition_appendix": {
    title: "Edition appendix (MRO / Food / later skins)",
    scope: "edition",
  },
  "diligence.methodology_and_limits": {
    title: "Methodology and limits",
    scope: "governance",
  },
  "diligence.data_fences": {
    title: "Data fences (Procuro LoE, no FSA client data)",
    scope: "governance",
  },
};

/** Horizontal body — always present. Edition appendix is additive. */
export const diligenceHorizontalSectionIds = diligenceSectionIds.filter(
  (id) => diligenceSectionMeta[id].scope === "horizontal",
);
