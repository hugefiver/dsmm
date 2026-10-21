export type DsmmModelFamily = "gpt" | "codex" | "claude" | "gemini" | "glm" | "kimi" | "deepseek" | "unknown";

const DOTTED_VENDOR_MODEL_PREFIXES: Record<string, RegExp> = {
  openai: /^(?:gpt-|o\d|chatgpt-|codex-)/,
  anthropic: /^claude-/,
  google: /^gemini-/,
  zhipu: /^glm-/,
  deepseek: /^deepseek-/
};

function stripDottedVendorModelPrefix(name: string): string {
  const parts = name.split(".");
  const vendor = parts[0];
  const model = parts.slice(1).join(".");
  if (vendor && DOTTED_VENDOR_MODEL_PREFIXES[vendor]?.test(model)) return model;

  const region = parts[0];
  const regionalVendor = parts[1];
  const regionalModel = parts.slice(2).join(".");
  if (
    region
    && regionalVendor
    && /^(?:[a-z]{2}|[a-z]{2}-[a-z]+-\d+)$/.test(region)
    && DOTTED_VENDOR_MODEL_PREFIXES[regionalVendor]?.test(regionalModel)
  ) {
    return regionalModel;
  }

  return name;
}

function extractModelName(fullID: string): string {
  const index = fullID.lastIndexOf("/");
  return stripDottedVendorModelPrefix(index >= 0 ? fullID.slice(index + 1) : fullID);
}

export function classifyModelFamily(input: { providerID?: string; modelID?: string }): DsmmModelFamily {
  const providerID = input.providerID?.trim().toLowerCase() ?? "";
  const modelID = input.modelID?.trim().toLowerCase() ?? "";
  const name = extractModelName(modelID);

  if (providerID.includes("codex") || name.includes("codex")) return "codex";
  if (name.includes("gpt")) return "gpt";
  if (providerID.includes("anthropic") || name.includes("claude")) return "claude";
  if (providerID === "google" || providerID === "google-vertex" || name.startsWith("gemini-")) return "gemini";
  if (providerID.includes("zhipu") || name.includes("glm")) return "glm";
  if (providerID.includes("moonshot") || providerID.includes("kimi") || name.includes("kimi") || /k2[-.]?p[567]/.test(name)) return "kimi";
  if (providerID.includes("deepseek") || name.includes("deepseek")) return "deepseek";
  return "unknown";
}
