import assert from "node:assert/strict";
import { test } from "node:test";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import type { DshCommandInvocation, DshCommandsRegistry, DshContext } from "../lib/dsh-types.js";
import { DSMM_STATUS_COMMAND, parseDeepworkCommandInput, registerDeepworkCommand, registerDsmmStatusCommand } from "../lib/commands.js";
import { DEFAULT_DSMM_SETTINGS, resolveConfig } from "../lib/settings.js";
import type { DsmmSettingsGetter } from "../lib/settings.js";
import { liveRolePolicyIdentity, pinRoleRoute } from "../lib/role-routing.js";
import { createDsmmStatusSnapshot, formatDsmmStatus } from "../lib/status.js";
import { DeepworkModeController } from "../lib/state.js";

type RegisteredCommand = Parameters<DshCommandsRegistry["register"]>[0];

function captureCommand(settings = DEFAULT_DSMM_SETTINGS): RegisteredCommand {
  let command: RegisteredCommand | undefined;
  const controller = new DeepworkModeController({});
  const ctx: DshContext = {
    commands: { register(value) { command = value; } }
  };

  registerDeepworkCommand(ctx, controller, () => settings);
  assert.ok(command);
  return command;
}

test("parseDeepworkCommandInput handles off and message forms", () => {
  assert.deepEqual(parseDeepworkCommandInput(""), { action: "on", message: "" });
  assert.deepEqual(parseDeepworkCommandInput(" off"), { action: "off", message: "" });
  assert.deepEqual(parseDeepworkCommandInput(" build the feature"), { action: "on", message: "build the feature" });
});

test("registerDeepworkCommand is optional when commands service is absent", () => {
  const controller = new DeepworkModeController({});
  assert.doesNotThrow(() => registerDeepworkCommand({}, controller, () => DEFAULT_DSMM_SETTINGS));
});

test("registerDeepworkCommand resolves the optional commands service without an inject declaration", () => {
  let command: RegisteredCommand | undefined;
  const controller = new DeepworkModeController({});
  const ctx = new Proxy({
    get(name: string) {
      if (name !== "commands") return undefined;
      return { register(value: RegisteredCommand) { command = value; } };
    }
  }, {
    get(target, property, receiver) {
      if (property === "commands") throw new Error("commands was read directly without inject");
      return Reflect.get(target, property, receiver);
    }
  }) as unknown as DshContext;

  assert.doesNotThrow(() => registerDeepworkCommand(ctx, controller, () => DEFAULT_DSMM_SETTINGS));
  assert.equal(command?.name, "deepwork");
});

test("registerDsmmStatusCommand is optional and resolves commands through get without direct property access", () => {
  const commands: RegisteredCommand[] = [];
  const controller = new DeepworkModeController({});
  const ctx = new Proxy({
    get(name: string) {
      if (name !== "commands") return undefined;
      return { register(command: RegisteredCommand) { commands.push(command); } };
    }
  }, {
    get(target, property, receiver) {
      if (property === "commands") throw new Error("commands was read directly without inject");
      return Reflect.get(target, property, receiver);
    }
  }) as unknown as DshContext;

  assert.doesNotThrow(() => registerDsmmStatusCommand({}, controller, () => DEFAULT_DSMM_SETTINGS));
  assert.doesNotThrow(() => registerDsmmStatusCommand(ctx, controller, () => DEFAULT_DSMM_SETTINGS));
  assert.equal(commands.length, 1);
  assert.equal(commands[0]?.name, DSMM_STATUS_COMMAND);
  assert.match(commands[0]?.description ?? "", /Deepwork status/i);
  assert.equal(commands[0]?.input?.hint, "[json]");
});

test("registered status command reads live settings and has no status-only session side effects", async () => {
  const commands: RegisteredCommand[] = [];
  const session = Session.create(SessionId("status-command"));
  const steered: unknown[] = [];
  let settingsCalls = 0;
  let currentSettings = resolveConfig({
    defaultActive: false,
    runtimeRecovery: {
      enabled: true,
      fallbackRoutes: [{ provider: "first", model: "first-model" }],
      idleContinuation: { enabled: false, maxContinuations: 2 }
    }
  });
  const controller = new DeepworkModeController({});
  const agent: DshCommandInvocation["agent"] = {
    async runMaintenance(task) { return task(new AbortController().signal); },
    session,
    steer(message) {
      steered.push(message);
    }
  };
  const ctx: DshContext = {
    commands: { register(command) { commands.push(command); } }
  };

  registerDsmmStatusCommand(ctx, controller, () => {
    settingsCalls += 1;
    return currentSettings;
  });
  const command = commands.find((candidate) => candidate.name === DSMM_STATUS_COMMAND);
  assert.ok(command);

  const humanBaseline = { steered: steered.length, events: session.snapshotEvents() };
  const expectedHuman = formatDsmmStatus(createDsmmStatusSnapshot({
    agent,
    settings: currentSettings,
    modeActive: controller.active(agent, currentSettings.defaultActive)
  }));
  const human = await command.handler({ rawInput: "   ", agent });

  assert.deepEqual(human, { kind: "success", text: expectedHuman });
  assert.deepEqual({ steered: steered.length, events: session.snapshotEvents() }, humanBaseline);

  await controller.select(agent, true, currentSettings.defaultActive);
  currentSettings = resolveConfig({
    defaultActive: true,
    runtimeRecovery: {
      enabled: true,
      fallbackRoutes: [
        { provider: "second", model: "second-model" },
        { provider: "third", model: "third-model" }
      ],
      idleContinuation: { enabled: true, maxContinuations: 7 }
    }
  });
  const jsonBaseline = { steered: steered.length, events: session.snapshotEvents() };
  const json = await command.handler({ rawInput: "json", agent });

  assert.equal(json.kind, "success");
  const snapshot = JSON.parse(json.text ?? "") as ReturnType<typeof createDsmmStatusSnapshot>;
  assert.equal(snapshot.mode.active, true);
  assert.equal(snapshot.effectiveSettings.defaultActive, true);
  assert.equal(snapshot.runtimeRecovery.fallbackRouteCount, 0);
  assert.equal(snapshot.effectiveSettings.runtimeRecovery.fallbackRoutes.length, 2, "declared profile routes remain available without implying root switches");
  assert.deepEqual(snapshot.runtimeRecovery.idleContinuation, { enabled: true, maxContinuations: 7 });
  assert.deepEqual({ steered: steered.length, events: session.snapshotEvents() }, jsonBaseline);
  assert.equal(settingsCalls, 2);
});

test("registered status command rejects invalid input without reading settings or mode state", async () => {
  let command: RegisteredCommand | undefined;
  let settingsCalls = 0;
  const controller = {
    active() {
      throw new Error("status controller must not be read for invalid input");
    }
  } as unknown as DeepworkModeController;

  registerDsmmStatusCommand({
    commands: { register(value) { command = value; } }
  }, controller, () => {
    settingsCalls += 1;
    return DEFAULT_DSMM_SETTINGS;
  });
  assert.ok(command);

  for (const rawInput of ["JSON", "status", "json extra", "anything else"]) {
    assert.deepEqual(await command.handler({
      rawInput,
      agent: { session: { events: [], append() {} } }
    } satisfies DshCommandInvocation), { kind: "error", text: "Usage: /dsmm-status [json]" });
  }
  assert.equal(settingsCalls, 0);
});

test("registered status command reports the exact Agent admission and current epoch retry state", async () => {
  let command: RegisteredCommand | undefined;
  const settings = resolveConfig({ roleRouting: { "dsmm-reviewer": { strategy: "rate-limit-fallback",
    primary: { provider: "p", model: "primary" }, fallbackRoutes: [{ provider: "p", model: "fallback", reasoningEffort: "high" }] } } });
  const agent: DshCommandInvocation["agent"] = { session: { header: { agentPreset: "dsmm-reviewer" }, events: [],
    append() { throw new Error("status must not write the session"); } } };
  let epoch = "a".repeat(64);
  let admissionCalls = 0;
  const getSettings: DsmmSettingsGetter = (target) => { assert.equal(target, agent); return settings; };
  getSettings.admission = (target) => {
    assert.equal(target, agent);
    admissionCalls += 1;
    return { settings, profile: { id: "focus", revision: "b".repeat(64) }, epoch, scope: "session-override" };
  };
  const identity = liveRolePolicyIdentity(agent, settings, "dsmm-reviewer", epoch);
  assert.ok(identity);
  const lock = pinRoleRoute(agent, identity, { provider: "p", model: "fallback", reasoningEffort: "high" }, settings.roleRouting["dsmm-reviewer"]!.fallbackRoutes!);
  lock.retries = 2;
  lock.rateLimits = 3;
  lock.switches = 1;
  lock.totalDelayMs = 1500;
  registerDsmmStatusCommand({ commands: { register(value) { command = value; } } }, new DeepworkModeController({}), getSettings);
  assert.ok(command);
  const response = await command.handler({ rawInput: "json", agent });
  const snapshot = JSON.parse(response.text ?? "") as ReturnType<typeof createDsmmStatusSnapshot>;
  assert.deepEqual(snapshot.admission, { profile: { id: "focus", revision: "b".repeat(64) }, epoch, scope: "session-override" });
  assert.equal(snapshot.rolePolicy.runtimeState!.retries, 2);
  assert.equal(snapshot.rolePolicy.runtimeState!.rateLimitFailures, 3);
  assert.equal(snapshot.rolePolicy.runtimeState!.switches, 1);
  assert.equal(snapshot.rolePolicy.runtimeState!.totalDelayMs, 1500);
  assert.deepEqual(snapshot.rolePolicy.runtimeState!.route, { provider: "p", model: "fallback", reasoningEffort: "high" });
  epoch = "c".repeat(64);
  const switched = JSON.parse((await command.handler({ rawInput: "json", agent })).text ?? "") as ReturnType<typeof createDsmmStatusSnapshot>;
  assert.equal(switched.admission!.epoch, epoch);
  assert.equal(switched.rolePolicy.runtimeState!.retries, 0);
  assert.equal(switched.rolePolicy.runtimeState!.route, undefined);
  assert.equal(admissionCalls, 2);
});

test("registered command name follows settings.modeName", () => {
  const command = captureCommand({ ...DEFAULT_DSMM_SETTINGS, modeName: "dw" });

  assert.equal(command.name, "dw");
  assert.equal(command.input?.hint, "[off|message]");
});

test("registered command turns mode on and steers non-empty input", async () => {
  const command = captureCommand();
  const session = Session.create(SessionId("mode-on-command"));
  const steered: unknown[] = [];
  const result = await command.handler({
    rawInput: " inspect repo",
    agent: {
      async runMaintenance(task) { return task(new AbortController().signal); },
      session,
      steer: (message) => steered.push(message)
    }
  } satisfies DshCommandInvocation);

  assert.deepEqual(session.snapshotEvents().map(({ type, data }) => ({ type, data })), [{ type: "plugin:dsmm/mode", data: { active: true } }]);
  assert.equal(new DeepworkModeController({}).active({ session }, false), true);
  assert.equal(steered.length, 1);
  assert.deepEqual(steered[0], {
    id: (steered[0] as { id: unknown }).id,
    role: "user",
    content: [{ type: "text", text: "inspect repo" }],
    source: { kind: "user" }
  });
  assert.deepEqual(result, { kind: "success", text: "Entering deepwork mode." });
});

test("registered command turns mode off without steering", async () => {
  const command = captureCommand();
  const session = Session.create(SessionId("mode-off-command"));
  const steered: unknown[] = [];
  const result = await command.handler({
    rawInput: " off",
    agent: {
      async runMaintenance(task) { return task(new AbortController().signal); },
      session,
      steer: (message) => steered.push(message)
    }
  } satisfies DshCommandInvocation);

  assert.deepEqual(session.snapshotEvents().map(({ type, data }) => ({ type, data })), [{ type: "plugin:dsmm/mode", data: { active: false } }]);
  assert.equal(new DeepworkModeController({}).active({ session }, false), false);
  assert.equal(steered.length, 0);
  assert.deepEqual(result, { kind: "success", text: "Leaving deepwork mode." });
});

test("registered command can turn off a default-active mode", async () => {
  const command = captureCommand({ ...DEFAULT_DSMM_SETTINGS, defaultActive: true });
  const session = Session.create(SessionId("default-active-off-command"));
  const result = await command.handler({
    rawInput: " off",
    agent: { session,
      async runMaintenance(task) { return task(new AbortController().signal); } }
  } satisfies DshCommandInvocation);

  assert.deepEqual(session.snapshotEvents().map(({ type, data }) => ({ type, data })), [{ type: "plugin:dsmm/mode", data: { active: false } }]);
  assert.equal(new DeepworkModeController({}).active({ session }, true), false);
  assert.deepEqual(result, { kind: "success", text: "Leaving deepwork mode." });
});
