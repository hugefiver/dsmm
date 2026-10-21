export type RouteJson = null | boolean | number | string | RouteJson[] | { [key: string]: RouteJson };
export type ModelRouteJson = {
  provider: string;
  model: string;
  reasoningEffort?: string;
} & { [key: string]: RouteJson };

const MAX_ROUTE_BYTES = 128 * 1024;
const hostFields = new Set([
  "provider", "model", "messages", "tools", "toolHistory", "system", "input",
  "agent", "agentId", "role", "roleId", "session", "sessionId", "signal",
  "permission", "permissions", "auth", "authorization", "apiKey", "apiKeyEnv", "credentials",
  "headers", "endpoint", "apiEndpoint", "baseURL", "url", "fetch", "onPayload", "callbacks",
  "stream", "stream_options", "tool_choice", "parallel_tool_calls", "functions", "function_call",
  "timeout", "timeoutMs", "transport", "transformHeaders", "onResponse",
  "context", "systemPromptUpdate", "toolUpdate", "adapterDefaults",
  "readOnly", "toolFilter", "authorityCeiling", "guards", "roleRouting", "runtimePolicy", "runtimePolicyCapture",
  "subagents", "allowRouteOverride", "maxDepth", "toolTopology", "profilePin", "originalAdmissionEpoch", "admissionEpoch",
  "childSessionId", "parentSessionId",
].map(parameterKey));
const aliases = [
  ["reasoningEffort", "reasoning_effort"],
  ["maxTokens", "max_tokens", "max_completion_tokens", "max_output_tokens"],
];
function parameterKey(key: string): string { return key.toLowerCase().replace(/[-_]/gu, ""); }
function fail(): never { throw new TypeError("Model routes must contain bounded plain JSON and valid route fields"); }
const routeFields = new Set(["provider", "model", "temperature", "stop", ...aliases.flat()]);

export function validateModelRouteFieldName(key: string): void {
  if (["__proto__", "prototype", "constructor"].includes(key)) fail();
  if (routeFields.has(key)) return;
  if (hostFields.has(parameterKey(key))
    || [...routeFields].some(field => parameterKey(field) === parameterKey(key))) fail();
}

/** Copies only lossless JSON, without evaluating getters or accepting prototype keys. */
export function copyRouteJson<T>(input: T): T {
  const active = new Set<object>();
  const copy = (value: unknown, depth: number): unknown => {
    if (depth > 32) fail();
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") { if (new TextDecoder("utf-8", { ignoreBOM: true }).decode(new TextEncoder().encode(value)) !== value) fail(); return value; }
    if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return value;
    if (typeof value !== "object" || value === null || active.has(value)) fail();
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) fail();
    if (Object.getOwnPropertySymbols(value).length) fail();
    active.add(value);
    const result: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (Array.isArray(value) && key === "length") continue;
      if (new TextDecoder("utf-8", { ignoreBOM: true }).decode(new TextEncoder().encode(key)) !== key || ["__proto__", "prototype", "constructor"].includes(key)
        || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) fail();
      if (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/u.test(key)) fail();
      Reflect.set(result, key, copy(descriptor.value, depth + 1));
    }
    if (Array.isArray(value) && Object.keys(result).length !== value.length) fail();
    active.delete(value);
    return result;
  };
  const result = copy(input, 0) as T;
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_ROUTE_BYTES) fail();
  return result;
}

function boundedText(value: unknown, max: number): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) fail();
}

/** Sparse deployment routes validate present fields; identity is required on complete values. */
export function normalizeModelRouteJson(input: unknown, sparse = false, allowIdentityWhitespace = false): ModelRouteJson {
  const route = copyRouteJson(input);
  if (route === null || typeof route !== "object" || Array.isArray(route)) fail();
  const row = route as Record<string, RouteJson>;
  if (!sparse && (!Object.hasOwn(row, "provider") || !Object.hasOwn(row, "model"))) fail();
  for (const key of Object.keys(row)) {
    validateModelRouteFieldName(key);
    const value = row[key];
    if (key === "provider") {
      boundedText(value, 128);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/u.test(allowIdentityWhitespace ? value.trim() : value)) fail();
    } else if (key === "model") {
      boundedText(value, 512);
      if (value.includes("://")) fail();
    } else if (key === "reasoningEffort" || key === "reasoning_effort") {
      boundedText(value, 64);
    } else if (key === "temperature") {
      if (typeof value !== "number") fail();
    } else if (aliases[1].includes(key)) {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) fail();
    } else if (key === "stop") {
      if (!Array.isArray(value) || !value.every(item => typeof item === "string")) fail();
    }
  }
  for (const group of aliases) if (group.filter(key => Object.hasOwn(row, key)).length > 1) fail();
  return row as ModelRouteJson;
}

/** Stable complete-value identity; not a replacement for legacy capture or role-pin hashes. */
export function canonicalModelRouteJson(input: unknown): string {
  const order = (value: RouteJson): RouteJson => Array.isArray(value) ? value.map(order)
    : value !== null && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, order(value[key])])) : value;
  return JSON.stringify(order(normalizeModelRouteJson(input) as { [key: string]: RouteJson }));
}

export function sameModelRouteJson(left: unknown, right: unknown): boolean {
  return canonicalModelRouteJson(left) === canonicalModelRouteJson(right);
}
