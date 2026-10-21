import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DsmmDelegationGroup, DsmmRoleMode } from "./roles.js";

// This content-only dependency must not import settings or model routing:
// roles need it during ESM initialization, including prompts-first imports.
const sourceRoot = join(dirname(dirname(fileURLToPath(import.meta.url))), "prompts", "source");
const assets = new Map<string, string>();
export function readPromptAsset(path: string): string {
  let text = assets.get(path);
  if (text === undefined) { text = readFileSync(join(sourceRoot, path), "utf8").trim(); assets.set(path, text); }
  return text;
}

export interface SourceRoleContent {
  id: string;
  sourceId: string;
  kind: "role" | "category";
  name: string;
  description: string;
  order: number;
  mode: DsmmRoleMode;
  enabledByDefault: boolean;
  access: "read-only" | "write";
  delegation: DsmmDelegationGroup;
  allowedChildren: string[];
  childBuilderAllowedChildren?: string[];
  promptArtifact: string | null;
  terminalArtifact: string;
}

export const SOURCE_ROLE_CATALOG: readonly SourceRoleContent[] = JSON.parse(readPromptAsset("catalog.json"));

export function buildRoleIdentity(role: Pick<SourceRoleContent, "name" | "id">): string {
  return `You are ${role.name} (role ID: ${role.id}).`;
}

export function splitCategory(text: string): { base: string; calibrations: Map<string, string> } {
  const calibrations = new Map<string, string>();
  const base = text.replace(/\r?\n?<model-calibration model="([^"]+)">\r?\n([\s\S]*?)\r?\n<\/model-calibration>\r?\n?/gu,
    (_block, model: string, calibration: string) => { calibrations.set(model, calibration.trim()); return "\n"; }).trim();
  return { base, calibrations };
}

export function buildRolePersona(role: SourceRoleContent): string {
  const source = role.promptArtifact === null ? role.description : readPromptAsset(role.promptArtifact.replace("prompts/source/", ""));
  const body = role.kind === "category" ? splitCategory(source).base : source;
  return [buildRoleIdentity(role), readPromptAsset("shared/locale.md"), body, readPromptAsset("shared/dsh-host-contract.md"), readPromptAsset(role.terminalArtifact.replace("prompts/source/", ""))].filter(Boolean).join("\n\n---\n\n");
}
