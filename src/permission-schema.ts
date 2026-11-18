import z from "@deepseek-ai/schemastery";
import { parseNativeCommands } from "./permission-settings.js";
import type { PermissionControlSettings } from "./permission-settings.js";
import { parsePermissionRules } from "./permission-rules.js";

export const nativeCommandMatchSchema = z.object({ tool: z.union(["bash", "pwsh"]).required(), workingDirectory: z.string().required(), commandPattern: z.string().required() }).required();
export const nativeCommandEntrySchema = z.object({
  id: z.string().required(), mode: z.union(["ask", "allow"]).required(), match: nativeCommandMatchSchema, sandboxMode: z.union(["workspace-write", "danger-full-access"]).required(),
}).required();
const nativeCommands = z.object({ enabled: z.boolean().default(false), entries: z.array(z.union([z.string(), nativeCommandEntrySchema])).default([]) });
const action = () => z.union(["inherit", "allow", "ask", "deny"]).default("inherit");
const web = () => z.object({ enabled: z.boolean().default(true), rule: action() }).default({});
export const permissionControlSchema: z<PermissionControlSettings> = z.transform(z.object({ enabled: z.boolean().default(true), outsideReads: action(), webSearch: web(), webFetch: web(),
  nativeCommands, rules: z.array(z.any()).default([]) }), input => Object.freeze({ ...input, webSearch: Object.freeze(input.webSearch), webFetch: Object.freeze(input.webFetch), rules: parsePermissionRules(input.rules), nativeCommands: parseNativeCommands(input.nativeCommands) }), true) as z<PermissionControlSettings>;
