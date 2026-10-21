import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import type { DshPreToolDecision, DshToolExecution } from "./dsh-types.js";

const GUARD_PREFIX = "[dsmm safety]";
const PLAN_PATH_PATTERN = /^(?:docs\/superpowers\/plans|\.omo\/plans)\/[^/]+\.md$/iu;
const PLAN_PATH_SUFFIX_PATTERN = /(?:^|\/)(?:docs\/superpowers\/plans|\.omo\/plans)\/[^/]+\.md$/iu;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringField(value: unknown, keys: readonly string[]): string | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;

  for (const key of keys) {
    if (typeof record[key] === "string") return record[key];
  }

  return undefined;
}

function normalizedPath(path: string): string {
  return path.replace(/\\/gu, "/");
}

function hasPlanPathSuffix(path: string): boolean {
  return PLAN_PATH_SUFFIX_PATTERN.test(posix.normalize(normalizedPath(path)));
}

function isOutside(cwd: string, target: string): boolean {
  const targetRelative = relative(cwd, target);
  return isAbsolute(targetRelative) || targetRelative === ".." || targetRelative.startsWith(`..${sep}`);
}

function malformedChecklistLine(content: string): string | undefined {
  return content.split(/\r?\n/u).find((line) => {
    const token = /^\s*[-*]\s+(\[[^\]\r\n]*(?:\]|$))/u.exec(line)?.[1];
    return token !== undefined && !/^\[(?: |x|X)\]$/u.test(token);
  });
}

function malformedChecklistDecision(content: string): DshPreToolDecision | undefined {
  const malformed = malformedChecklistLine(content);
  if (malformed === undefined) return undefined;
  return {
    kind: "deny",
    reason: `${GUARD_PREFIX} plan file contains a malformed checklist entry: ${malformed.trim()}`
  };
}

function validateWrite(arguments_: Record<string, unknown>): DshPreToolDecision | undefined {
  if (typeof arguments_.content !== "string") {
    return { kind: "deny", reason: `${GUARD_PREFIX} cannot validate plan write: content must be a string` };
  }
  return malformedChecklistDecision(arguments_.content);
}

function validateEdit(arguments_: Record<string, unknown>): DshPreToolDecision {
  if (typeof arguments_.old_string !== "string" || arguments_.old_string === "") {
    return { kind: "deny", reason: `${GUARD_PREFIX} cannot validate plan edit: old_string must be non-empty` };
  }
  if (typeof arguments_.new_string !== "string") {
    return { kind: "deny", reason: `${GUARD_PREFIX} cannot validate plan edit: new_string must be a string` };
  }
  if (arguments_.replace_all !== undefined && typeof arguments_.replace_all !== "boolean") {
    return { kind: "deny", reason: `${GUARD_PREFIX} cannot validate plan edit: replace_all must be boolean` };
  }
  return { kind: "deny", reason: `${GUARD_PREFIX} unsupported-full-preview: protected plan edit requires an authorized complete pre-commit document preview, unavailable on rc.2. Use a complete document write; native permissions, observation and CAS still apply.` };
}

export function validatePlanMutation(exec: DshToolExecution): DshPreToolDecision | undefined {
  const name = exec.name.toLowerCase();
  if (name !== "write" && name !== "edit") return undefined;

  const arguments_ = asRecord(exec.arguments);
  const suppliedPath = stringField(arguments_, ["file_path", "path"]);
  if (arguments_ === undefined || suppliedPath === undefined) return undefined;

  const cwd = resolve(exec.agent?.session.header?.cwd ?? process.cwd());
  const target = resolve(cwd, suppliedPath);
  if (isOutside(cwd, target)) {
    if (!hasPlanPathSuffix(suppliedPath)) return undefined;
    return { kind: "deny", reason: `${GUARD_PREFIX} cannot validate plan target outside session cwd: ${suppliedPath}` };
  }

  const targetRelative = normalizedPath(relative(cwd, target));
  if (!PLAN_PATH_PATTERN.test(targetRelative)) return undefined;
  return name === "write" ? validateWrite(arguments_) : validateEdit(arguments_);
}
