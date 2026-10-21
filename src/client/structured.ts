import { applyEdits, findNodeAtLocation, modify, parse, parseTree } from "jsonc-parser";
import type { Node, ParseError } from "jsonc-parser";
import type { DsmmLevelOverride, DsmmModelRoute, DsmmRoleRoutingConfig } from "../settings.js";
import type { DsmmRateLimitPolicy, DsmmRuntimePolicySettings } from "../routing-policy.js";
import { normalizeRateLimitOverrides, normalizeRoutingStrategy } from "../routing-policy.js";

export type JsonPath = (string | number)[];
export interface StructuredDocument {
  label?: string;
  settings: Record<string, unknown>;
  roleRouting: Record<string, DsmmRoleRoutingConfig>;
  runtimePolicy: { strategy?: DsmmRuntimePolicySettings["strategy"]; rateLimit?: Partial<DsmmRateLimitPolicy> };
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
// Project known control fields; opaque parameters remain raw for Host validation.
function route(value: unknown): value is DsmmModelRoute {
  return record(value) && typeof value.provider === "string" && typeof value.model === "string"
    && (value.reasoningEffort === undefined || typeof value.reasoningEffort === "string");
}
function level(value: unknown): value is DsmmLevelOverride {
  return route(value) || record(value) && value.provider === undefined && value.model === undefined && typeof value.reasoningEffort === "string";
}
function validTree(node: Node, depth = 0): boolean {
  if (depth > 32) return false;
  if (node.type === "object") {
    const seen = new Set<string>();
    for (const property of node.children ?? []) {
      const key: unknown = property.children?.[0]?.value;
      if (typeof key !== "string" || seen.has(key) || ["__proto__", "prototype", "constructor"].includes(key)) return false;
      seen.add(key);
    }
  }
  return (node.children ?? []).every((child) => validTree(child, depth + 1));
}

/** Read-only projection. Malformed raw drafts cannot be rewritten by the form. */
export function structuredDocument(content: string): StructuredDocument | null {
  const errors: ParseError[] = [];
  const tree = parseTree(content, errors, { allowTrailingComma: true });
  if (errors.length !== 0 || tree === undefined || !validTree(tree)) return null;
  const document: unknown = parse(content, errors, { allowTrailingComma: true });
  if (errors.length !== 0 || !record(document) || document.version !== 1 || typeof document.id !== "string"
    || !record(document.settings) || (document.label !== undefined && typeof document.label !== "string")) return null;
  const settings = document.settings;
  if (settings.defaultActive !== undefined && typeof settings.defaultActive !== "boolean") return null;
  if (settings.locale !== undefined && typeof settings.locale !== "string") return null;
  if (settings.roles !== undefined && (!record(settings.roles) || !Object.values(settings.roles).every(value => typeof value === "boolean"))) return null;
  if (settings.subagents !== undefined && (!record(settings.subagents) || Object.keys(settings.subagents).some(key => key !== "toolTopology")
    || settings.subagents.toolTopology !== undefined && (typeof settings.subagents.toolTopology !== "string"
      || !["per-role", "parameterized"].includes(settings.subagents.toolTopology)))) return null;
  if (settings.roleRouting !== undefined && !record(settings.roleRouting)) return null;
  if (settings.runtimePolicy !== undefined && !record(settings.runtimePolicy)) return null;
  const runtimePolicy = settings.runtimePolicy ?? {};
  const policies = settings.roleRouting ?? {};
  try {
    if (Object.keys(runtimePolicy).some((key) => key !== "strategy" && key !== "rateLimit")) return null;
    if (runtimePolicy.strategy !== undefined) normalizeRoutingStrategy(runtimePolicy.strategy);
    if (runtimePolicy.rateLimit !== undefined) normalizeRateLimitOverrides(runtimePolicy.rateLimit);
    for (const [role, raw] of Object.entries(policies)) {
      if (!record(raw) || Object.keys(raw).some((key) => !["primary", "fallbackRoutes", "strategy", "rateLimit", "levels"].includes(key))) return null;
      if (raw.levels !== undefined && (role === "dsmm-orchestrator" || !record(raw.levels)
        || Object.entries(raw.levels).some(([key, value]) => !["low", "high", "max"].includes(key) || !level(value)))) return null;
      if (raw.primary !== undefined && !route(raw.primary)) return null;
      if (raw.fallbackRoutes !== undefined && (!Array.isArray(raw.fallbackRoutes) || raw.fallbackRoutes.length > 32 || !raw.fallbackRoutes.every(route))) return null;
      if (raw.strategy !== undefined) normalizeRoutingStrategy(raw.strategy);
      if (raw.rateLimit !== undefined) normalizeRateLimitOverrides(raw.rateLimit);
    }
  } catch { return null; }
  return { label: document.label as string | undefined, settings, roleRouting: policies as Record<string, DsmmRoleRoutingConfig>, runtimePolicy };
}

/** Only the named path changes; comments/unrelated raw JSONC remain untouched. */
export function editStructuredPath(content: string, path: JsonPath, value: unknown): string | null {
  if (structuredDocument(content) === null) return null;
  try { return applyEdits(content, modify(content, path, value, {})); }
  catch { return null; }
}

export function moveFallback(content: string, role: string, from: number, to: number): string | null {
  const document = structuredDocument(content);
  const chain = document?.roleRouting[role]?.fallbackRoutes;
  if (chain === undefined || from < 0 || from >= chain.length || to < 0 || to >= chain.length) return null;
  // Move the original object text, not parsed/serialized values, so even the
  // edited rows retain their internal comments and manual identifier spelling.
  const low = Math.min(from, to), high = Math.max(from, to);
  const tree = parseTree(content);
  if (tree === undefined) return null;
  const nodes = chain.map((_, index) => findNodeAtLocation(tree, ["settings", "roleRouting", role, "fallbackRoutes", index]));
  if (nodes.some((node) => node === undefined)) return null;
  const order = nodes.map((node) => content.slice(node!.offset, node!.offset + node!.length));
  order.splice(to, 0, order.splice(from, 1)[0]);
  return applyEdits(content, nodes.slice(low, high + 1).map((node, offset) => ({ offset: node!.offset, length: node!.length, content: order[low + offset] })));
}
