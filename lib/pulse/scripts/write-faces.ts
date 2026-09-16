import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  pulseCoreIssue20260916,
  renderDiligenceTemplate,
  renderPulseCoreIssue,
} from "../src/index.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
mkdirSync(join(root, "docs/pulse/issues"), { recursive: true });
mkdirSync(join(root, "docs/pulse/diligence"), { recursive: true });
writeFileSync(
  join(root, "docs/pulse/issues/2026-09-16-core.md"),
  renderPulseCoreIssue(pulseCoreIssue20260916),
);
writeFileSync(
  join(root, "docs/pulse/diligence/template.md"),
  renderDiligenceTemplate(null),
);
