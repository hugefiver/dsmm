import type { DeploymentAdmissionView, DeploymentEditorSnapshot, DeploymentSchemaNode } from "../profile-types.js";
import type { DeploymentPathEdit } from "../deployment-config.js";
import { parseTree } from "jsonc-parser";
import { copyRouteJson, normalizeModelRouteJson } from "../route-json.js";

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function scopeSchema(snapshot: DeploymentEditorSnapshot, layer: "global" | "profile"): DeploymentSchemaNode {
  return layer === "profile" ? snapshot.nativeSchema ?? snapshot.schema : snapshot.schema;
}
export function at(value: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>((node, key) => record(node) && Object.hasOwn(node, key) ? node[key] : undefined, value);
}
export function equal(a: unknown, b: unknown): boolean {
  if (record(a) && record(b)) return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, i) => equal(value, b[i]));
  return a === b;
}
export function mergeLayer(base: unknown, override: unknown): unknown {
  if (!record(base) || !record(override)) return override;
  return Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(override)])].map(key => [key,
    Object.hasOwn(override, key) ? mergeLayer(base[key], override[key]) : base[key]]));
}
/** Strict JSON with duplicate-key rejection; never silently last-key-wins. */
export function parseAdvanced(text: string): unknown {
  if (text.trim() === "") return undefined;
  const errors: import("jsonc-parser").ParseError[] = [];
  const root = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false });
  const unique = (node: import("jsonc-parser").Node): boolean => {
    if (node.type === "object") {
      const keys = node.children!.map(child => child.children![0].value);
      if (new Set(keys).size !== keys.length) return false;
    }
    return (node.children ?? []).every(unique);
  };
  if (root === undefined || errors.length || !unique(root)) throw new Error("Invalid JSON");
  return JSON.parse(text);
}
export function editLayer(base: Record<string, unknown>, path: readonly string[], value: unknown): Record<string, unknown> {
  const next = structuredClone(base);
  let node = next;
  for (const key of path.slice(0, -1)) { if (!record(node[key])) node[key] = {}; node = node[key] as Record<string, unknown>; }
  const key = path.at(-1)!;
  if (value === undefined) delete node[key]; else node[key] = structuredClone(value);
  return next;
}
/** Preserve untouched sparse fields; arrays are one schema field, not indexed RPC paths. */
export function layerDiff(base: Record<string, unknown>, draft: Record<string, unknown>, prefix: string[] = []): DeploymentPathEdit[] {
  return [...new Set([...Object.keys(base), ...Object.keys(draft)])].flatMap(key => {
    const path = [...prefix, key], before = base[key], after = draft[key];
    if (equal(before, after)) return [];
    if (!Object.hasOwn(draft, key)) return [{ op: "unset" as const, path }];
    if (record(before) && record(after)) return layerDiff(before, after, path);
    return [{ op: "set" as const, path, value: after }];
  });
}
export function validateEditorValue(value: unknown, schema: DeploymentSchemaNode, sparse = false): boolean {
  if (schema.type === "transform") return schema.inner !== undefined && validateEditorValue(value, schema.inner, sparse);
  if (schema.type === "any") { try { copyRouteJson(value); return true; } catch { return false; } }
  if (schema.type === "union") return schema.alternatives?.some(node => validateEditorValue(value, node, sparse)) === true;
  if (schema.type === "const") return value === schema.value;
  if (schema.type === "object" && schema.additionalProperties === "json") {
    try {
      if (schema.fields?.provider?.type === "string" && schema.fields.model?.type === "string") {
        normalizeModelRouteJson(value, sparse, true); return true;
      }
      copyRouteJson(value);
    } catch { return false; }
  }
  if (schema.type === "object" || schema.type === "dict") return record(value) && (sparse || schema.type !== "object" || Object.entries(schema.fields ?? {}).every(([key, node]) => !node.required || Object.hasOwn(value, key))) && Object.entries(value).every(([key, child]) => {
    if (["__proto__", "prototype", "constructor"].includes(key)) return false;
    if (schema.keys !== undefined && !schema.keys.includes(key)) return false;
    const node = schema.type === "dict" ? schema.inner : schema.fields !== undefined && Object.hasOwn(schema.fields, key) ? schema.fields[key] : undefined;
    return node !== undefined ? validateEditorValue(child, node, sparse) : schema.type === "object" && schema.additionalProperties === "json";
  });
  if (schema.type === "array") return Array.isArray(value) && (schema.max === undefined || value.length <= schema.max) && schema.inner !== undefined && value.every(child => validateEditorValue(child, schema.inner!));
  if (schema.type === "string" && schema.nonempty) return typeof value === "string" && value.trim() !== "";
  if (["string", "boolean", "number"].includes(schema.type)) return typeof value === schema.type && (typeof value !== "number" || Number.isFinite(value) && (schema.min === undefined || value >= schema.min) && (schema.max === undefined || value <= schema.max) && (schema.step === undefined || Number.isInteger(value / schema.step)));
  return false;
}

export function enumValues(schema: DeploymentSchemaNode): Array<string | number | boolean> | null {
  return schema.type === "union" && schema.alternatives?.every(node => node.type === "const")
    ? schema.alternatives.map(node => node.value!) : null;
}

export function visibleDeploymentPath(path: readonly string[]): boolean {
  return !["lsp", "modeName", "section"].includes(path[0]);
}

/** Only visible Host-projected inspector layers, never raw sparse editor input. */
export function inspectorPaths(snapshot: DeploymentEditorSnapshot, admitted: DeploymentAdmissionView | null): string[] {
  const paths = new Set<string>([...Object.keys(snapshot.sources), ...Object.keys(snapshot.startupSources ?? {}), ...Object.keys(snapshot.nextRoot?.sources ?? {}),
    ...Object.keys(snapshot.nextRoot?.captures ?? {}), ...Object.keys(admitted?.sources ?? {}), ...Object.keys(admitted?.captures ?? {})]);
  const visit = (value: unknown, path: string[]): void => {
    if (!visibleDeploymentPath(path)) return;
    if (record(value) && Object.keys(value).length) for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
    else if (path.length) paths.add(path.join("."));
  };
  for (const value of [snapshot.desired, snapshot.startup, snapshot.nextRoot?.settings, admitted?.settings]) if (value !== undefined) visit(value, []);
  return [...paths].filter(path => visibleDeploymentPath(path.split("."))).sort();
}
