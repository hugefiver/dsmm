import assert from "node:assert/strict";
import { test } from "node:test";
import type { DshPostToolDecision, DshPreToolDecision, DshSessionEvent, DshToolExecution, DshToolExecutionResult } from "../lib/dsh-types.js";
import { DSMM_GUARD_PREFIX, decidePostToolExecution, decidePreToolExecution, isSafetyScopeActive, registerSafetyGuards, truncateTextMiddle } from "../lib/guards.js";
import { DEFAULT_DSMM_SETTINGS } from "../lib/settings.js";
import type { DsmmSettings } from "../lib/settings.js";
import { DEEPWORK_MODE_EVENT, DeepworkModeController } from "../lib/state.js";

function controller(): DeepworkModeController {
  return new DeepworkModeController({});
}

function exec(name: string, args: unknown, active = true): DshToolExecution {
  return {
    name,
    arguments: args,
    agent: {
      session: {
        events: active ? [{ type: DEEPWORK_MODE_EVENT, data: { active: true } }] : [],
        append() {}
      }
    }
  };
}

test("safety scope is active for deepwork mode and resolves persisted preset precedence", () => {
  assert.equal(isSafetyScopeActive(exec("bash", { command: "pwd" }), DEFAULT_DSMM_SETTINGS, controller()), true);
  assert.equal(isSafetyScopeActive(exec("bash", { command: "pwd" }, false), DEFAULT_DSMM_SETTINGS, controller()), false);

  const cases: readonly [string, string, readonly DshSessionEvent[], boolean][] = [
    ["header reviewer without events", "dsmm-reviewer", [], true],
    ["header standard with reviewer event", "standard", [{ type: "agent-preset/selected", data: { agentPreset: "dsmm-reviewer" } }], true],
    ["header reviewer with standard event", "dsmm-reviewer", [{ type: "agent-preset/selected", data: { agentPreset: "standard" } }], false],
    ["newest valid standard event wins", "standard", [
      { type: "agent-preset/selected", data: { agentPreset: "dsmm-reviewer" } },
      { type: "agent-preset/selected", data: { agentPreset: "standard" } }
    ], false],
    ["malformed newest event does not mask older reviewer event", "standard", [
      { type: "agent-preset/selected", data: { agentPreset: "dsmm-reviewer" } },
      { type: "agent-preset/selected", data: { agentPreset: 3 } }
    ], true],
    ["malformed events fall back to header", "dsmm-reviewer", [{ type: "agent-preset/selected", data: { agentPreset: 3 } }], true]
  ];

  for (const [name, agentPreset, events, expected] of cases) {
    assert.equal(isSafetyScopeActive({
      name: "bash",
      arguments: { command: "pwd" },
      agent: { session: { header: { agentPreset }, events, append() {} } }
    }, DEFAULT_DSMM_SETTINGS, controller()), expected, name);
  }

  assert.equal(
    isSafetyScopeActive(exec("bash", { command: "pwd" }), {
      ...DEFAULT_DSMM_SETTINGS,
      guards: { ...DEFAULT_DSMM_SETTINGS.guards, scope: "off" }
    }, controller()),
    false
  );
});

test("pwsh shell safety denies clear POSIX-only syntax", () => {
  assert.deepEqual(decidePreToolExecution(exec("pwsh", { command: "export CI=true; pnpm test" }), DEFAULT_DSMM_SETTINGS, controller()), {
    kind: "deny",
    reason: `${DSMM_GUARD_PREFIX} PowerShell command appears to use POSIX shell syntax (\`export\`). Use \`$env:NAME = "value"; command\` instead.`
  });
});

test("pwsh shell safety denies POSIX null redirection and source", () => {
  const nullDecision = decidePreToolExecution(exec("powershell", { command: "pnpm test > /dev/null" }), DEFAULT_DSMM_SETTINGS, controller());
  const sourceDecision = decidePreToolExecution(exec("pwsh", { command: "source ./env" }), DEFAULT_DSMM_SETTINGS, controller());

  assert.equal(nullDecision?.kind, "deny");
  assert.match(
    nullDecision.reason,
    /POSIX null redirection/
  );
  assert.equal(sourceDecision?.kind, "deny");
  assert.match(
    sourceDecision.reason,
    /POSIX `source`/
  );
});

test("bash shell safety denies clear PowerShell-only syntax", () => {
  const decision = decidePreToolExecution(exec("bash", { command: "$env:CI = \"true\"; pnpm test" }), DEFAULT_DSMM_SETTINGS, controller());

  assert.equal(decision?.kind, "deny");
  assert.match(decision?.reason ?? "", /PowerShell syntax/);
});

test("git write guard asks for approval by default", () => {
  assert.deepEqual(decidePreToolExecution(exec("bash", { command: "git commit -m test" }), DEFAULT_DSMM_SETTINGS, controller()), {
    kind: "ask",
    reason: `${DSMM_GUARD_PREFIX} git write command requires explicit user approval before running: git commit`
  });
});

test("git write guard can be configured to deny", () => {
  const settings = { ...DEFAULT_DSMM_SETTINGS, guards: { ...DEFAULT_DSMM_SETTINGS.guards, gitWriteGuard: "deny" as const } };
  const decision = decidePreToolExecution(exec("pwsh", { command: "git push origin master" }), settings, controller());

  assert.equal(decision?.kind, "deny");
  assert.match(decision?.reason ?? "", /git write command is disabled/);
  const off = { ...settings, modules: { deepwork: { enabled: false } }, guards: { ...settings.guards, scope: "always" as const } };
  assert.equal(decidePreToolExecution(exec("pwsh", { command: "git push origin master" }, false), off, controller())?.kind, "deny");
  assert.equal(decidePreToolExecution(exec("pwsh", { command: "git push origin master" }, false), { ...off, guards: { ...off.guards, scope: "off" } }, controller()), undefined);
  assert.equal(decidePreToolExecution(exec("todo_write", { todos: [{ status: "pending" }] }, false), off, controller()), undefined, "off module does not add DW workflow discipline to ordinary tools");
});

test("git write guard detects destructive operation forms and honors off policy", () => {
  const resetDecision = decidePreToolExecution(exec("bash", { command: "git reset --hard HEAD" }), DEFAULT_DSMM_SETTINGS, controller());
  const stashDecision = decidePreToolExecution(exec("bash", { command: "git stash clear" }), DEFAULT_DSMM_SETTINGS, controller());

  assert.equal(resetDecision?.kind, "ask");
  assert.match(
    resetDecision.reason ?? "",
    /git reset --hard/
  );
  assert.equal(stashDecision?.kind, "ask");
  assert.match(
    stashDecision.reason ?? "",
    /git stash clear/
  );
  assert.equal(
    decidePreToolExecution(exec("bash", { command: "git clean -fd" }), {
      ...DEFAULT_DSMM_SETTINGS,
      guards: { ...DEFAULT_DSMM_SETTINGS.guards, gitWriteGuard: "off" }
    }, controller()),
    undefined
  );
});

test("git write guard detects staging and repository mutation commands", () => {
  for (const command of ["git add .", "git rm old.ts", "git mv old.ts new.ts", "git merge feature", "git stash"]) {
    const decision = decidePreToolExecution(exec("bash", { command }), DEFAULT_DSMM_SETTINGS, controller());

    assert.equal(decision?.kind, "ask", command);
    assert.match(decision.reason ?? "", /git write command requires explicit user approval/);
  }
});

test("git write guard detects write commands after git global options", () => {
  const commands = [
    "git -C repo commit -m test",
    "git --no-pager push origin main",
    "git -c user.name=test commit -m test",
    "git --git-dir=.git --work-tree=. tag v1.0.0"
  ];

  for (const command of commands) {
    const decision = decidePreToolExecution(exec("bash", { command }), DEFAULT_DSMM_SETTINGS, controller());

    assert.equal(decision?.kind, "ask", command);
    assert.match(decision.reason ?? "", /git write command requires explicit user approval/);
  }
});

test("git write guard detects commands separated by shell newlines", () => {
  const commands = [
    "git status\ngit commit -m test",
    "echo ok\ngit push origin main",
    "git status\r\ngit tag v1.0.0"
  ];

  for (const command of commands) {
    const decision = decidePreToolExecution(exec("bash", { command }), DEFAULT_DSMM_SETTINGS, controller());

    assert.equal(decision?.kind, "ask", command);
    assert.match(decision.reason ?? "", /git write command requires explicit user approval/);
  }
});

test("pwsh shell safety detects POSIX syntax after shell newlines", () => {
  const exportDecision = decidePreToolExecution(exec("pwsh", { command: "Write-Output ok\nexport CI=true" }), DEFAULT_DSMM_SETTINGS, controller());
  const sourceDecision = decidePreToolExecution(exec("pwsh", { command: "Write-Output ok\r\nsource ./env" }), DEFAULT_DSMM_SETTINGS, controller());

  assert.equal(exportDecision?.kind, "deny");
  assert.match(exportDecision.reason ?? "", /POSIX shell syntax/);
  assert.equal(sourceDecision?.kind, "deny");
  assert.match(sourceDecision.reason ?? "", /POSIX `source`/);
});

test("shell safety ignores quoted prose and recognizes PowerShell source command positions", () => {
  assert.equal(
    decidePreToolExecution(exec("pwsh", { command: "Write-Output 'export CI=true source ./env > /dev/null'" }), DEFAULT_DSMM_SETTINGS, controller()),
    undefined
  );
  const decision = decidePreToolExecution(exec("powershell", { command: "Write-Output ok\nSoUrCe ./env.ps1" }), DEFAULT_DSMM_SETTINGS, controller());

  assert.equal(decision?.kind, "deny");
  assert.match(decision?.reason ?? "", /POSIX `source`/);
});

test("git write guard uses dialect-aware parsing for call operators and known Git mutations", () => {
  const cases: readonly [string, string, string][] = [
    ["bash", "env -i CI=true git tag v1", "git tag"],
    ["bash", "env -v git commit -m smoke", "git commit"],
    ["bash", "env -vvC. git commit -m smoke", "git commit"],
    ["bash", "env --file=NUL git commit -m smoke", "git commit"],
    ["bash", "env --ignore-signal git commit -m smoke", "git commit"],
    ["bash", "env -S 'git commit -m smoke'", "git commit"],
    ["bash", "env env git commit -m smoke", "git commit"],
    ["bash", "env - PATH=/bin git commit -m smoke", "git commit"],
    ["bash", "env -C. git commit -m smoke", "git commit"],
    ["bash", "env -- git commit -m smoke", "git commit"],
    ["bash", "env -- CI=true git commit -m smoke", "git commit"],
    ["bash", "env -- FOO-BAR=1 git commit -m smoke", "git commit"],
    ["bash", "env -- =x git commit -m smoke", "git commit"],
    ["bash", "git config user.name Alice", "git config"],
    ["bash", "git symbolic-ref HEAD refs/heads/main", "git symbolic-ref"],
    ["pwsh", '& "C:\\Program Files\\Git\\cmd\\git.exe" push origin main', "git push"],
    ["pwsh", "Write-Output ok\ngit update-ref refs/heads/x HEAD", "git update-ref"]
  ];

  for (const [shell, command, operation] of cases) {
    const decision = decidePreToolExecution(exec(shell, { command }), DEFAULT_DSMM_SETTINGS, controller());

    assert.equal(decision?.kind, "ask", command);
    assert.match(decision?.reason ?? "", new RegExp(operation));
  }
});

test("git write guard leaves Git reads, unknown subcommands, and quoted prose unclassified", () => {
  for (const command of ["git config user.name", "git symbolic-ref HEAD", "git publish", "printf '%s' 'git commit -m x'"]) {
    assert.equal(decidePreToolExecution(exec("bash", { command }), DEFAULT_DSMM_SETTINGS, controller()), undefined, command);
  }
});

test("plan format validation rejects malformed checklist entries", () => {
  const decision = decidePreToolExecution(exec("write", {
    file_path: "docs/superpowers/plans/example.md",
    content: "# Example Implementation Plan\n\n- [] Missing space\n"
  }), DEFAULT_DSMM_SETTINGS, controller());

  assert.equal(decision?.kind, "deny");
  assert.match(decision?.reason ?? "", /malformed checklist/);
});

test("plan format validation runs only when enabled", () => {
  const disabled = {
    ...DEFAULT_DSMM_SETTINGS,
    guards: { ...DEFAULT_DSMM_SETTINGS.guards, planFormatValidation: false }
  };
  const decision = decidePreToolExecution(exec("write", {
    path: ".omo/plans/example.md",
    content: "- [todo] Missing checkbox status\n"
  }), disabled, controller());

  assert.equal(decision, undefined);
});

test("question label helper rejects overlong option labels", () => {
  const decision = decidePreToolExecution(exec("ask_user_question", {
    questions: [{ id: "q1", question: "Choose?", options: [{ label: "this label is definitely longer than thirty characters" }] }]
  }), DEFAULT_DSMM_SETTINGS, controller());

  assert.equal(decision?.kind, "deny");
  assert.match(decision?.reason ?? "", /question option label exceeds 30 characters/);
});

test("question label helper ignores non-dsh question tool names", () => {
  assert.equal(decidePreToolExecution(exec("question", {
    questions: [{ id: "q1", question: "Choose?", options: [{ label: "this label is definitely longer than thirty characters" }] }]
  }), DEFAULT_DSMM_SETTINGS, controller()), undefined);
});

test("legacy todo discipline retains the structured content convention", () => {
  const decision = decidePreToolExecution(exec("todo_write", {
    todos: [
      { content: "fix guards", status: "in_progress" },
      { content: "[docs] [write] to document guards - expect docs", status: "pending" }
    ]
  }), { ...DEFAULT_DSMM_SETTINGS, workflow: { ...DEFAULT_DSMM_SETTINGS.workflow, policy: "legacy" } }, controller());

  assert.equal(decision?.kind, "deny");
  assert.match(decision?.reason ?? "", /todo content must use/);
});

test("todo discipline helper rejects missing active todo only for unfinished work", () => {
  const missingActive = decidePreToolExecution(exec("todo_write", {
    todos: [{ content: "[code] [edit] to implement guards - expect passing tests", status: "pending" }]
  }), DEFAULT_DSMM_SETTINGS, controller());
  const completed = decidePreToolExecution(exec("todo_write", {
    todos: [{ content: "[code] [edit] to implement guards - expect passing tests", status: "completed" }]
  }), DEFAULT_DSMM_SETTINGS, controller());

  assert.equal(missingActive?.kind, "deny");
  assert.match(missingActive?.reason ?? "", /at least one in_progress/);
  assert.equal(completed, undefined);
});

test("risk-based todo policy accepts plain imperatives and native parallel work", () => {
  assert.equal(decidePreToolExecution(exec("todo_write", { todos: [
    { content: "Update the adapter", status: "in_progress" },
    { content: "Verify tool contracts", status: "in_progress" }
  ] }), DEFAULT_DSMM_SETTINGS, controller()), undefined);
});

test("post-execute preserves error bodies and their metadata without truncation", () => {
  const result = { isError: true, content: [{ type: "text", text: "e".repeat(15000) }], error: { code: "DENIED" } };
  const decision = { kind: "accept" as const };
  assert.equal(decidePostToolExecution(exec("bash", {}), result, decision, DEFAULT_DSMM_SETTINGS, controller()), decision);
});

test("registerSafetyGuards wires tools/pre-execute and delegates when allowed", async () => {
  const listeners: Record<string, (...args: any[]) => unknown> = {};
  registerSafetyGuards({
    on(event, listener, options) {
      listeners[event] = listener;
      assert.deepEqual(options, { prepend: true });
    }
  }, controller(), () => DEFAULT_DSMM_SETTINGS);

  assert.equal(typeof listeners["tools/pre-execute"], "function");
  const preExecute = listeners["tools/pre-execute"] as (execution: DshToolExecution, next: () => Promise<DshPreToolDecision>) => Promise<DshPreToolDecision>;
  const allowed = await preExecute(exec("bash", { command: "pwd" }), async (): Promise<DshPreToolDecision> => ({ kind: "allow" }));

  assert.deepEqual(allowed, { kind: "allow" });
});

test("registerSafetyGuards composes pre-execute decisions monotonically", async () => {
  const listeners: Record<string, (...args: any[]) => unknown> = {};
  const denySettings = {
    ...DEFAULT_DSMM_SETTINGS,
    guards: { ...DEFAULT_DSMM_SETTINGS.guards, gitWriteGuard: "deny" as const }
  };
  const askSettings = DEFAULT_DSMM_SETTINGS;
  registerSafetyGuards({
    on(event, listener) {
      listeners[event] = listener;
    }
  }, controller(), () => askSettings);

  const preExecute = listeners["tools/pre-execute"] as (execution: DshToolExecution, next: () => Promise<DshPreToolDecision>) => Promise<DshPreToolDecision>;
  const cases: readonly [string, DshToolExecution, DsmmSettings, DshPreToolDecision, DshPreToolDecision, boolean][] = [
    ["local deny short-circuits", exec("bash", { command: "git commit -m test" }), denySettings, { kind: "allow" }, {
      kind: "deny",
      reason: `${DSMM_GUARD_PREFIX} git write command is disabled by dsmm settings: git commit`
    }, false],
    ["local none returns downstream directly", exec("bash", { command: "pwd" }), askSettings, { kind: "ask" }, { kind: "ask" }, true],
    ["downstream deny dominates local ask", exec("bash", { command: "git commit -m test" }), askSettings, { kind: "deny", reason: "downstream" }, { kind: "deny", reason: "downstream" }, true],
    ["downstream ask dominates local ask", exec("bash", { command: "git commit -m test" }), askSettings, { kind: "ask", reason: "downstream" }, { kind: "ask", reason: "downstream" }, true],
    ["local ask survives downstream allow", exec("bash", { command: "git commit -m test" }), askSettings, { kind: "allow" }, {
      kind: "ask",
      reason: `${DSMM_GUARD_PREFIX} git write command requires explicit user approval before running: git commit`
    }, true]
  ];

  for (const [name, execution, settings, downstream, expected, callsNext] of cases) {
    let nextCalls = 0;
    registerSafetyGuards({
      on(event, listener) {
        listeners[event] = listener;
      }
    }, controller(), () => settings);
    const result = await (listeners["tools/pre-execute"] as typeof preExecute)(execution, async () => {
      nextCalls += 1;
      return downstream;
    });

    assert.deepEqual(result, expected, name);
    assert.equal(nextCalls === 1, callsNext, name);
  }
  const off = { ...askSettings, modules: { deepwork: { enabled: false } }, guards: { ...askSettings.guards, scope: "always" as const } };
  registerSafetyGuards({ on(event, listener) { listeners[event] = listener; } }, controller(), () => off);
  const execution = exec("pwsh", { command: "git push" }, false);
  assert.equal((await (listeners["tools/pre-execute"] as typeof preExecute)(execution, async () => ({ kind: "allow" }))).kind, "ask");
  const nativeDenial: DshPreToolDecision = { kind: "deny", reason: "native host refusal" };
  assert.equal(await (listeners["tools/pre-execute"] as typeof preExecute)(execution, async () => nativeDenial), nativeDenial);
});

test("truncateTextMiddle keeps head and tail with dsmm notice", () => {
  const text = "a".repeat(40) + "b".repeat(40) + "c".repeat(40);
  const truncated = truncateTextMiddle(text, 80, "bash");

  assert.ok(Buffer.byteLength(truncated, "utf8") <= 80);
  assert.match(truncated, /\[dsmm safety\] truncated/);
  assert.match(truncated, /^a+/);
  assert.match(truncated, /c+$/);
});

test("truncateTextMiddle respects UTF-8 byte caps when the notice barely fits", () => {
  const truncated = truncateTextMiddle("😀".repeat(50), 17, "bash");

  assert.equal(truncated, "[dsmm safety] tru");
  assert.ok(Buffer.byteLength(truncated, "utf8") <= 17);
});

test("post-execute truncates accepted plain-text content when scoped", () => {
  const activeExec = exec("bash", { command: "yes" });
  const result = { isError: false, content: [{ type: "text", text: "x".repeat(140) }] };
  const settings = { ...DEFAULT_DSMM_SETTINGS, guards: { ...DEFAULT_DSMM_SETTINGS.guards, toolOutputTruncation: { enabled: true, maxInlineBytes: 90 } } };
  const decision = decidePostToolExecution(activeExec, result, { kind: "accept" }, settings, controller());

  assert.equal(decision.kind, "accept");
  assert.ok(!("value" in decision));
  assert.equal(decision.content?.length, 1);
  assert.ok(Buffer.byteLength(decision.content?.[0].text ?? "", "utf8") <= 90);
  assert.match(decision.content?.[0].text ?? "", /\[dsmm safety\] truncated/);
});

test("post-execute leaves value decisions and out-of-scope calls unchanged", () => {
  const inactiveExec = exec("bash", { command: "yes" }, false);
  const result = { isError: false, content: [{ type: "text", text: "x".repeat(140) }] };
  const settings = { ...DEFAULT_DSMM_SETTINGS, guards: { ...DEFAULT_DSMM_SETTINGS.guards, toolOutputTruncation: { enabled: true, maxInlineBytes: 90 } } };
  const contentDecision = { kind: "accept" as const };
  const valueDecision = { kind: "accept" as const, value: { full: true } };

  assert.equal(decidePostToolExecution(inactiveExec, result, contentDecision, settings, controller()), contentDecision);
  assert.equal(decidePostToolExecution(exec("bash", { command: "yes" }), result, valueDecision, settings, controller()), valueDecision);
});

test("post-execute leaves mixed content and disabled truncation unchanged", () => {
  const mixed = { kind: "accept" as const, content: [{ type: "text", text: "x".repeat(140) }, { type: "image", source: "inline" }] };
  const settings = { ...DEFAULT_DSMM_SETTINGS, guards: { ...DEFAULT_DSMM_SETTINGS.guards, toolOutputTruncation: { enabled: true, maxInlineBytes: 90 } } };
  const disabled = { ...DEFAULT_DSMM_SETTINGS, guards: { ...DEFAULT_DSMM_SETTINGS.guards, toolOutputTruncation: { enabled: false, maxInlineBytes: 90 } } };
  const result = { isError: false, content: [{ type: "text", text: "x".repeat(140) }] };
  const contentDecision = { kind: "accept" as const };

  assert.equal(decidePostToolExecution(exec("bash", { command: "yes" }), result, mixed, settings, controller()), mixed);
  assert.equal(decidePostToolExecution(exec("bash", { command: "yes" }), result, contentDecision, disabled, controller()), contentDecision);
});

test("registerSafetyGuards wires tools/post-execute and delegates before truncating", async () => {
  const listeners: Record<string, (...args: any[]) => unknown> = {};
  const settings = { ...DEFAULT_DSMM_SETTINGS, guards: { ...DEFAULT_DSMM_SETTINGS.guards, toolOutputTruncation: { enabled: true, maxInlineBytes: 90 } } };
  let delegated = false;
  let settingsAvailable = true;
  registerSafetyGuards({
    on(event, listener, options) {
      listeners[event] = listener;
      assert.deepEqual(options, { prepend: true });
    }
  }, controller(), () => { assert.equal(settingsAvailable, true); return settings; });

  assert.equal(typeof listeners["tools/post-execute"], "function");
  const postExecute = listeners["tools/post-execute"] as (execution: DshToolExecution, result: DshToolExecutionResult, next: () => Promise<DshPostToolDecision>) => Promise<DshPostToolDecision>;
  const execution = exec("bash", { command: "yes" });
  await listeners["tools/pre-execute"](execution, async () => ({ kind: "allow" }));
  settingsAvailable = false;
  const decision = await postExecute(
    execution,
    { isError: false, content: [{ type: "text", text: "x".repeat(140) }] },
    async () => {
      delegated = true;
      return { kind: "accept" };
    }
  );

  assert.equal(delegated, true);
  assert.equal(decision.kind, "accept");
  assert.match(decision.content?.[0].text ?? "", /\[dsmm safety\] truncated/);
});
