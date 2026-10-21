import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FRONTEND_PINS = {
  "open-design": { repository: "nexu-io/open-design", commit: "6afe7eae156bfa29251a51fd0636649c257f7444", license: "Apache-2.0", licenseBlob: "eb79c35bd865477e525b18e56f35d56fbe0f7110", licenseTarget: "LICENSE-Apache-2.0.txt", notice: null },
  "taste-skill": { repository: "Leonxlnx/taste-skill", commit: "06d6028b5c623016c59ce8536f578e5a1127b499", license: "MIT", licenseBlob: "48a2f6640b81ff8eca9ce7f6a96337692713ef5b", licenseTarget: "LICENSE-taste-skill.txt", notice: null },
  "ui-ux-pro-max": { repository: "nextlevelbuilder/ui-ux-pro-max-skill", commit: "f32d6a61cdf0bfd57404c45854583fd19ff95088", license: "MIT", licenseBlob: "1e71cbf26660f31903807d099fe902c098fc7e4c", licenseTarget: "LICENSE-ui-ux-pro-max.txt", notice: null }
};
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const styles = ["taste-skill", "gpt-tasteskill", "minimalist-skill", "brutalist-skill", "soft-skill", "redesign-skill", "image-to-code-skill", "output-skill", "stitch-skill", "imagegen-frontend-web", "imagegen-frontend-mobile", "imagegen-brandkit"];
const data = ["charts", "colors", "icons", "landing", "products", "react-performance", "styles", "typography", "ui-reasoning", "ux-guidelines", "web-interface", "google-fonts", "app-interface"];
const stacks = ["astro", "flutter", "html-tailwind", "jetpack-compose", "nextjs", "nuxt-ui", "nuxtjs", "react-native", "react", "shadcn", "svelte", "swiftui", "vue", "threejs", "angular", "laravel"];

export function frontendRecipe(root = packageRoot, index = readFileSync(join(root, "skills/frontend/references/design/_INDEX.md"), "utf8")) {
  const begin = index.indexOf("## Layer B — Design Systems"), end = index.indexOf("### Mood-based shortcuts", begin);
  if (begin < 0 || end < 0) throw new Error("frontend source index anchor drift: Layer B brand table");
  const brands = [...index.slice(begin, end).matchAll(/^\| `([\w.-]+)\.md` \|/gmu)].map((match) => match[1]);
  if (!brands.includes("aside") || new Set(brands).size !== brands.length) throw new Error("frontend source index is missing original aside or has duplicate brands");
  const files = [];
  const add = (upstream, source, target, reason = "declared source resource") => files.push({ upstream, source, target, reason });
  for (const brand of brands.filter((name) => name !== "aside")) add("open-design", `design-systems/${brand.replaceAll(".", "-")}/DESIGN.md`, `references/design/${brand}.md`);
  for (const style of styles) add("taste-skill", `skills/${style === "imagegen-brandkit" ? "brandkit" : style}/SKILL.md`, `references/design/${style}.md`);
  add("taste-skill", "skills/stitch-skill/DESIGN.md", "references/design/stitch-design-example.md");
  add("ui-ux-pro-max", ".claude/skills/ui-ux-pro-max/SKILL.md", "references/ui-ux-db/README.md");
  for (const name of ["core", "design_system", "search"]) add("ui-ux-pro-max", `src/ui-ux-pro-max/scripts/${name}.py`, `references/ui-ux-db/scripts/${name}.py`);
  for (const name of data) add("ui-ux-pro-max", `src/ui-ux-pro-max/data/${name === "web-interface" ? "app-interface" : name}.csv`, `references/ui-ux-db/data/${name}.csv`, name === "app-interface" ? "verbatim core.py runtime name; web-interface mapping is retained too" : name === "google-fonts" ? "actual core.py CSV_CONFIG dependency at this fixed pin" : "declared source data");
  for (const name of stacks) add("ui-ux-pro-max", `src/ui-ux-pro-max/data/stacks/${name}.csv`, `references/ui-ux-db/data/stacks/${name}.csv`, ["threejs", "angular", "laravel"].includes(name) ? "actual core.py STACK_CONFIG dependency at this fixed pin" : "declared source stack");
  for (const [upstream, pin] of Object.entries(FRONTEND_PINS)) add(upstream, "LICENSE", pin.licenseTarget, "verbatim fixed-pin license and copyright notice; committed, not ignored");
  return files;
}

export function frontendAttribution() {
  return `# Frontend attribution and materialization notice

The DSMM-maintained frontend router, index, guidance and modifications remain under the package's complete LicenseRef-AAAPL LICENSE. The separable third-party files below retain their original licenses/notices; they are not represented as AAAPL-only or relicensed.

## Exact source recipe

The standalone maintainer recipe is scripts/frontend-recipe.mjs together with this skill's complete references/design/_INDEX.md and .frontend-materialized.json inventory. Run the explicitly authorized pnpm run sync:frontend command to fetch missing immutable GitHub content; ordinary build/check is offline and refuses missing or changed resources. The complete materialized tree and integrity/provenance inventory are maintained and shipped with the project.

### Open Design

- Source: https://github.com/nexu-io/open-design
- Exact commit: ${FRONTEND_PINS["open-design"].commit}
- Copyright 2026 Open Design contributors; Apache-2.0, full fixed-pin text in LICENSE-Apache-2.0.txt.
- Each brand named in the index's Layer B table maps from design-systems/<brand>/DESIGN.md, replacing dots with dashes in the upstream directory name. The project-maintained aside.md is never overwritten by an upstream file.
- No root NOTICE exists in this fixed tree (the parent's official API check returned 404); no notice is fabricated. Applicable notices in copied source files are retained.
- The index's historical VoltAgent/awesome-design-md attribution is preserved as lineage, not falsely declared the fetched vendor. This distribution's actual brand source is the fixed Open Design commit above.

### taste-skill

- Source: https://github.com/Leonxlnx/taste-skill
- Exact commit: ${FRONTEND_PINS["taste-skill"].commit}
- Copyright (c) 2026 Leonxlnx; MIT, full text in LICENSE-taste-skill.txt.
- The 12 declared style/image references map from skills/<name>/SKILL.md; imagegen-brandkit maps from skills/brandkit/SKILL.md. stitch-design-example.md maps from skills/stitch-skill/DESIGN.md. No other taste pin, HEAD or OMO directory is used.

### UI/UX Pro Max

- Source: https://github.com/nextlevelbuilder/ui-ux-pro-max-skill
- Exact commit: ${FRONTEND_PINS["ui-ux-pro-max"].commit}
- Copyright (c) 2024 Next Level Builder; MIT, full text in LICENSE-ui-ux-pro-max.txt.
- README maps from .claude/skills/ui-ux-pro-max/SKILL.md. core.py, design_system.py, search.py and CSV data map from src/ui-ux-pro-max.
- web-interface.csv maps from app-interface.csv. The original app-interface.csv name is shipped too because verbatim core.py consumes it. google-fonts.csv and threejs/angular/laravel stacks are actual dependencies at this pin, not invented data. Python imports only the shipped core/design_system siblings and standard library; these resources are not executed during synchronization/build.

## Modifications and authority

Third-party body/data/Python/license bytes are copied verbatim; path mapping and the app-interface/web-interface alias are the only resource layout changes. DSMM's maintained router, index and authority notes explain native DSH usage without rewriting third-party source. Source host/tool/platform names in a reference are not evidence that those tools or models are installed in DSH. Use actual native catalog capabilities and the resourceBase from native skill loading; software installation, downloads outside this explicit materialization operation, login, Git writes and destructive actions require exact authorization. No referenced code is executed by the materializer.

Product names, brands, typefaces and trademarks remain their owners' property. These references grant no trademark, font-binary, logo or proprietary-asset rights, and do not imply affiliation or endorsement. Fixed LICENSE texts were inspected for redistribution permission; this is not a comprehensive legal review, non-infringement opinion or DMCA guarantee.
`;
}
