import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import type { DshAgent, DshSkillCandidate, DshSkillLookupOptions, DshSkillRegistration, DshSkillRegistry } from "./dsh-types.js";
import { scopeOf, scopeParentOf } from "./native-scope.js";
import type { DsmmSettings, DsmmSettingsGetter } from "./settings.js";
import type { DeepworkModeController } from "./state.js";

export const DSMM_SKILL_NAMES = [
  "brainstorming",
  "writing-plans",
  "requesting-code-review",
  "receiving-code-review",
  "subagent-driven-development",
  "dispatching-parallel-agents",
  "remove-ai-slops",
  "debugging",
  "frontend",
  "git-master",
  "ast-grep",
  "coding-agent-sessions",
  "init-deep",
  "using-git-worktrees"
] as const;
export const MVP_SKILL_NAMES = DSMM_SKILL_NAMES;
export type DsmmSkillName = (typeof DSMM_SKILL_NAMES)[number];
export type DsmmAvailableSkillName = DsmmSkillName;
export type MvpSkillName = DsmmSkillName;

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** Packaged metadata only; discovery never reads SKILL.md. */
// BEGIN SOURCE SKILL METADATA
export const DSMM_SKILL_DESCRIPTIONS: Record<DsmmAvailableSkillName, string> = {
  "brainstorming": "Use before creative or materially ambiguous work to clarify outcomes, constraints, risks, and an appropriate implementation direction.",
  "writing-plans": "Use before complex product behavior implementation, or when an explicit planning request or concrete major risk requires a plan; not for routine non-product multi-step work",
  "requesting-code-review": "Use when an implemented change benefits from independent review before delivery or merge",
  "receiving-code-review": "Use when receiving code review feedback, before implementing suggestions, especially if feedback seems unclear or technically questionable - requires technical rigor and verification, not performative agreement or blind implementation",
  "subagent-driven-development": "Use when executing implementation plans with independent tasks in the current session",
  "dispatching-parallel-agents": "Use when facing 2+ independent tasks that can be worked on without shared state or sequential dependencies",
  "remove-ai-slops": "Remove AI-generated code slop from branch changes or an explicit file list. Establishes regression coverage for final valid requirements, then runs categorized cleanup with bounded permitted work and verifies with quality gates. Covers 10 slop categories. MUST USE when the user asks to \"remove slop\", \"clean AI code\", \"deslop\", \"clean up AI-generated code\", \"remove AI slop\", or wants to clean up AI-generated patterns.",
  "debugging": "MUST USE for any real runtime debugging across ANY language or binary — crashes, silent failures, wrong responses, stuck processes, memory leaks, async misbehavior, unexplained timing, flaky tests, intermittent failures, passes in isolation, different test fails, order-dependent behavior, CI-only failures, reverse engineering. Runs a hypothesis-driven loop: form ≥3 hypotheses, investigate in parallel, after 2 failed evidence rounds allow one hard-reasoning escalation only when the task is genuinely difficult, confirm root cause, capture a failing reproduction before the fix and verify the same case after, fix minimally, QA by actually USING the system, scrub artifacts. The actual HOW lives in `references/` — READ THEM. Triggers: 'debug this', 'why is X not working', 'hanging', 'attach a debugger', 'reverse engineer', 'pwndbg', 'gdb', 'lldb', 'node inspect', 'tsx debug', 'pdb', 'dlv', 'delve', 'rust-gdb', 'set a breakpoint', 'context window exploded', 'why is the response empty', 'attach the debugger', 'debug it', 'why is this happening', 'trace this bug', 'reproduce and fix', 'silent failure', 'HTTP 200 but empty', 'why did it stop', 'inspect the binary', 'reverse engineering', 'playwright', 'flaky test', 'intermittent failure', 'passes in isolation', 'different test fails', 'order-dependent', 'CI-only failure'.",
  "frontend": "MUST USE for ANY frontend, web UI, UX, or visual work — building, styling, or redesigning pages/components, React project setup, performance audits, design QA. Routes three rulesets: design (anti-slop taste router over 12 taste skills + 70 brand DESIGN.md refs — Apple, Stripe, Linear, Notion, Vercel, Claude, Nike, Aside — plus composable interaction mechanics and the React dev tooling gate: react-grab, react-scan, react-doctor), perfection (Lighthouse 100 in every category via real Playwright Chromium audits, NEVER the lighthouse CLI, never by weakening UX), ui-ux-db (searchable 50+ styles, 97 palettes, 57 font pairings, 99 UX guidelines). Triggers: frontend, UI, UX, design, redesign, styling, layout, animation, motion, interaction, interaction mechanics, state, reduced-motion, taste, premium, luxury, minimal, brutalist, Awwwards, anti-slop, polish, DESIGN.md, mockup, react setup, react-scan, react-doctor, lighthouse, performance, Core Web Vitals, LCP, CLS, INP, SEO, accessibility, a11y, WCAG, audit my site, make this faster, color palette, font pairing, looks generic, make it pretty, like X brand, clone site, clone from url.",
  "git-master": "MUST USE whenever a task needs a commit or git-history investigation. Covers atomic commits, staging, commit-message style, rebase, squash, fixup/autosquash, blame, bisect, reflog, git log -S/-G, and questions like who wrote this or when was this added. Do not use for ordinary code edits unless the user asks for git work.",
  "ast-grep": "Use ast-grep (sg) only when the task explicitly requires exact syntax-tree matching or a deterministic codemod that simpler rg/LSP lookup cannot express reliably. Examples: rewrite a specific call/import shape, strip `as any`, find empty catch blocks, or scan/apply YAML rules. Do not trigger for ordinary repository discovery, symbol navigation, text search, or one-off lookups that rg/LSP can answer.",
  "coding-agent-sessions": "MUST USE when asked to find, read, list, search, inspect, fetch, export, or reconstruct coding-agent sessions across Codex, Claude Code/Desktop, OpenCode, Senpi/pi, oh-my-pi (omp), gajae-code (gjc), OpenClaw, Factory Droid, Amp, Gemini/Kimi/Qwen CLIs, Codebuff, Roo/Kilo/Cline, Kodu, Cursor CLI, Aider, Aside browser-agent sessions, or unknown local agent logs. Covers transcripts, session IDs, rollout JSONL, state SQLite, Claude projects/pre-compact histories, OpenCode messages/parts, child/subagent linkage, cwd/model/time/token filters, archives, and cost clues. Expands fuzzy recall into parallel query lanes and first probes known stores so absent platforms are skipped cheaply. Triggers: coding agent sessions, Codex/Claude/OpenCode/Senpi/pi/oh-my-pi/omp/gajae-code/gjc/OpenClaw/Droid/Amp/Kodu/Cursor/Aider/Aside sessions, transcript search, session history, session ID, read transcript, token usage, subagent sessions, what did I do yesterday, did we already do this.",
  "init-deep": "(builtin) Initialize hierarchical AGENTS.md knowledge base",
  "using-git-worktrees": "Use ONLY when the user explicitly asks to use a git worktree for isolated feature work. Do not auto-trigger. Creates a linked worktree, sets up the project, and verifies a clean baseline before development begins."
};
// END SOURCE SKILL METADATA
export const BUNDLED_SKILL_RANK = 600;

export function bundledSkillMetadata(name: DsmmAvailableSkillName): Omit<DshSkillRegistration, "content"> {
  const directory = join(packageRoot, "skills", name);
  return { name, description: DSMM_SKILL_DESCRIPTIONS[name], source: "bundled", provider: "dsmm",
    resourceBase: { kind: "directory", path: directory }, invocation: { modelInvocable: true, userInvocable: true } };
}

export function parseSkillMarkdown(markdown: string): { name: string; description: string; content: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u.exec(markdown);
  if (match === null) throw new Error("skill markdown must start with YAML frontmatter");

  const frontmatter = match[1];
  const decode = (value: string | undefined): string | undefined => value === undefined ? undefined
    : value.startsWith('"') ? JSON.parse(value) : value.replace(/^'|'$/gu, "").replaceAll("''", "'");
  const name = decode(/^name:\s*(.+)$/mu.exec(frontmatter)?.[1]?.trim());
  const description = decode(/^description:\s*(.+)$/mu.exec(frontmatter)?.[1]?.trim());
  if (name === undefined || description === undefined) throw new Error("skill frontmatter needs name and description");

  return { name, description, content: match[2].replace(/^\r?\n/u, "") };
}

export function enabledSkillNames(settings: DsmmSettings): readonly DsmmSkillName[] {
  return DSMM_SKILL_NAMES.filter((name) => settings.skills[name]);
}

export async function readBundledSkill(name: DsmmAvailableSkillName, signal: AbortSignal): Promise<DshSkillRegistration> {
  const parsed = parseSkillMarkdown(await readFile(join(packageRoot, "skills", name, "SKILL.md"), { encoding: "utf8", signal }));
  if (parsed.name !== name) throw new Error(`dsmm bundled skill name mismatch: ${name}`);
  return { ...bundledSkillMetadata(name), content: parsed.content };
}

export interface BundledSkillProviderOptions {
  agent: DshAgent;
  controller: DeepworkModeController;
  getSettings: DsmmSettingsGetter;
  catalogReady?: () => boolean;
  /** Body I/O seam for deterministic cancellation/race contract tests. */
  load?: typeof readBundledSkill;
}

/** Exact Agent layer, native revision cache, metadata-only ancestor avoidance. */
export function registerBundledSkills(ctx: Context, skills: DshSkillRegistry, options: BundledSkillProviderOptions): { dispose(): void; invalidate(): void } {
  const agentScope = scopeOf(ctx);
  if (agentScope !== options.agent) throw new Error("dsmm refuses skills outside the exact Agent scope");
  let generation = 0;
  let invalidate = (): void => {};
  // The broadcast spans registries; fence in-flight work, not cached locators.
  const stopChange = ctx.on("skills/change", () => { generation += 1; }, { global: true });
  const names = (): readonly DsmmAvailableSkillName[] => {
    const settings = options.getSettings(options.agent);
    return settings.modules.deepwork.enabled && options.controller.active(options.agent, settings.defaultActive) ? enabledSkillNames(settings) : [];
  };
  let disposeProvider: () => void;
  try {
    disposeProvider = skills.registerProvider((control) => {
      invalidate = control.invalidate;
      const signalFor = (lookup: DshSkillLookupOptions): AbortSignal => lookup.signal === undefined ? control.signal : AbortSignal.any([lookup.signal, control.signal]);
      const ancestor = (lookup: DshSkillLookupOptions, signal: AbortSignal) => {
        signal.throwIfAborted();
        const parent = scopeParentOf(agentScope);
        return skills.snapshot({ ...(parent === undefined ? {} : { scope: parent }), cwd: lookup.cwd, signal });
      };
      const occupied = (snapshot: Awaited<ReturnType<DshSkillRegistry["snapshot"]>>, name: string): boolean =>
        snapshot.skills.some((skill) => skill.name === name && skill.provider !== "dsmm");
      return {
        name: "dsmm",
        async list(lookup) {
          const signal = signalFor(lookup), current = generation, parent = scopeParentOf(agentScope);
          signal.throwIfAborted();
          if (options.catalogReady?.() === false) return { candidates: [], complete: false };
          const enabled = names();
          if (enabled.length === 0) return [];
          const snapshot = await ancestor(lookup, signal);
          signal.throwIfAborted();
          if (!snapshot.complete || generation !== current || scopeParentOf(agentScope) !== parent || options.catalogReady?.() === false) return { candidates: [], complete: false };
          return enabled.filter((name) => !occupied(snapshot, name)).map((name): DshSkillCandidate => ({
            ...bundledSkillMetadata(name), rank: BUNDLED_SKILL_RANK, locator: { name, parent }
          }));
        },
        async get(candidate, lookup) {
          const signal = signalFor(lookup), current = generation;
          signal.throwIfAborted();
          if (options.catalogReady?.() === false) return undefined;
          const name = names().find((name) => name === candidate.name);
          const locator = candidate.locator;
          if (name === undefined || typeof locator !== "object" || locator === null
            || !("parent" in locator) || locator.parent !== scopeParentOf(agentScope)) return undefined;
          const snapshot = await ancestor(lookup, signal);
          signal.throwIfAborted();
          if (!snapshot.complete || occupied(snapshot, name) || generation !== current || locator.parent !== scopeParentOf(agentScope)) return undefined;
          const body = await (options.load ?? readBundledSkill)(name, signal);
          signal.throwIfAborted();
          if (generation !== current || !names().includes(name) || locator.parent !== scopeParentOf(agentScope)) return undefined;
          const after = await ancestor(lookup, signal);
          signal.throwIfAborted();
          return after.complete && !occupied(after, name) && generation === current && locator.parent === scopeParentOf(agentScope) ? body : undefined;
        }
      };
    });
  } catch (error) {
    stopChange();
    throw error;
  }
  const dispose = (): void => {
    stopChange(); disposeProvider();
  };
  return { dispose, invalidate };
}
