import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  diligenceSectionIds,
  diligenceTemplateSections,
  parsePulseCoreIssue,
  pulseCoreIssue20260916,
  renderDiligenceTemplate,
  renderPulseCoreIssue,
} from "../src/index";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("Pulse Core v0 fixture", () => {
  it("parses as a PulseCoreIssue", () => {
    const parsed = parsePulseCoreIssue(pulseCoreIssue20260916);
    expect(parsed?.id).toBe("pulse-2026-09-16");
    expect(parsed?.editionTags).toEqual(["mro", "food"]);
    expect(parsed?.cadence).toBe("weekly");
  });

  it("is one issue with two edition skins — not two products", () => {
    expect(pulseCoreIssue20260916.editionTags).toEqual(["mro", "food"]);
    const tags = new Set(
      pulseCoreIssue20260916.observe.flatMap((item) => item.verticalTags),
    );
    expect(tags.has("logistics")).toBe(true);
    expect(tags.has("mro")).toBe(true);
    expect(tags.has("food")).toBe(true);
  });

  it("cites public sources only and carries no Learn block", () => {
    for (const item of pulseCoreIssue20260916.observe) {
      expect(item.sourceUrl).toMatch(/^https:\/\//);
      expect(item.summary.toLowerCase()).not.toMatch(/\barr\b/);
      expect(item.summary.toLowerCase()).not.toMatch(/peer percentile/);
    }
    expect(
      parsePulseCoreIssue({
        ...pulseCoreIssue20260916,
        learnOutcomes: [{ outcome: "saved" }],
      }),
    ).toBeNull();
  });

  it("does not invent a Decide for every Observe row", () => {
    expect(pulseCoreIssue20260916.suggestedDecides.length).toBeGreaterThan(0);
    expect(pulseCoreIssue20260916.suggestedDecides.length).toBeLessThan(
      pulseCoreIssue20260916.observe.length + 3,
    );
  });
});

describe("Checked-in Pulse / Diligence faces", () => {
  it("keeps the Core issue markdown in sync with the renderer", () => {
    const onDisk = readFileSync(
      join(repoRoot, "docs/pulse/issues/2026-09-16-core.md"),
      "utf8",
    );
    expect(onDisk).toBe(renderPulseCoreIssue(pulseCoreIssue20260916));
  });

  it("keeps the Diligence template in sync with the renderer", () => {
    const onDisk = readFileSync(
      join(repoRoot, "docs/pulse/diligence/template.md"),
      "utf8",
    );
    expect(onDisk).toBe(renderDiligenceTemplate(null));
  });

  it("covers every Diligence section id", () => {
    const sections = diligenceTemplateSections(null);
    expect(sections.map((s) => s.id)).toEqual([...diligenceSectionIds]);
    const rendered = renderDiligenceTemplate("mro");
    expect(rendered).toContain("`mro`");
    expect(rendered).toContain("diligence.data_fences");
    expect(rendered).toContain("No FSA client data without John’s bridge");
  });
});
