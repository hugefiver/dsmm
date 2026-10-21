import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, watch } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { DapFrameParser, isTcpAdapterSpec, MAX_OUTPUT_BYTES, parseBreakpointSpec, tokenizeCommand } from "./dap.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const client = join(directory, "dap.mjs");
const fixture = join(directory, "fixture-adapter.mjs");

function frame(message) {
  const body = Buffer.from(JSON.stringify(message));
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}

function startSession(env = {}) {
  const child = spawn(process.execPath, [client], {
    cwd: directory,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  const listeners = new Set();

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
    for (const listener of listeners) listener();
  });
  child.stderr.on("data", (chunk) => { errors += chunk; });

  function waitFor(pattern) {
    const outputStart = output.length;
    return new Promise((resolve, reject) => {
      const matches = () => pattern.test(output.slice(outputStart));
      if (matches()) return resolve();
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(new Error(`timed out waiting for ${pattern}; stdout=${output}; stderr=${errors}`));
      }, 10_000);
      function check() {
        if (!matches()) return;
        clearTimeout(timer);
        listeners.delete(check);
        resolve();
      }
      listeners.add(check);
    });
  }

  return {
    child,
    command(value) { child.stdin.write(`${value}\n`); },
    output() { return output; },
    waitFor,
  };
}

async function quit(session) {
  const closed = once(session.child, "close");
  session.command("quit");
  await closed;
}

async function stopFixture(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill();
  await exited;
}

function createFixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "dap fixture "));
  const adapter = join(root, "fixture adapter.mjs");
  copyFileSync(fixture, adapter);
  return {
    root,
    adapter,
    capturePath: join(root, "capture.jsonl"),
    lifecyclePath: join(root, "lifecycle.txt"),
  };
}

function waitForFileValue(path) {
  return new Promise((resolve, reject) => {
    let watcher;
    let finished = false;
    const timer = setTimeout(() => finish(new Error(`timed out waiting for ${path}`)), 10_000);
    function value() {
      return existsSync(path) ? readFileSync(path, "utf8").trim() : "";
    }
    function finish(cause, result) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      watcher?.close();
      if (cause) reject(cause);
      else resolve(result);
    }
    watcher = watch(dirname(path), () => {
      const result = value();
      if (result) finish(null, result);
    });
    const initial = value();
    if (initial) finish(null, initial);
  });
}

async function startTcpFixture(paths, environment = {}) {
  const portPath = join(paths.root, "tcp-port.txt");
  const child = spawn(process.execPath, [paths.adapter], {
    env: { ...process.env, ...environment, DAP_FIXTURE_TCP_PORT_FILE: portPath },
    stdio: "ignore",
  });
  try {
    const port = Number(await waitForFileValue(portPath));
    assert.ok(Number.isInteger(port) && port > 0, `invalid fixture port: ${port}`);
    return { child, port };
  } catch (cause) {
    await stopFixture(child);
    throw cause;
  }
}

async function reserveUnusedLoopbackPort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function assertOutputLinesBounded(text) {
  for (const outputLine of text.split(/\r?\n/)) {
    if (!outputLine) continue;
    assert.ok(
      Buffer.byteLength(`${outputLine}\n`) <= MAX_OUTPUT_BYTES,
      `output line exceeded ${MAX_OUTPUT_BYTES} bytes`,
    );
  }
}

function fixturePid(path) {
  const pid = Number(readFileSync(path, "utf8").match(/^started (\d+)$/m)?.[1]);
  assert.ok(Number.isInteger(pid) && pid > 0, "fixture PID was not recorded");
  return pid;
}

test("DAP parsing preserves framing, quoted Windows paths, and malformed command rejection", () => {
  const parser = new DapFrameParser();
  const first = frame({ type: "event", event: "one" });
  const second = frame({ type: "event", event: "two", body: { ok: true } });
  assert.deepEqual(parser.push(Buffer.concat([first, second])), [
    { type: "event", event: "one" },
    { type: "event", event: "two", body: { ok: true } },
  ]);

  const third = frame({ type: "response", seq: 3 });
  assert.deepEqual(parser.push(third.subarray(0, 9)), []);
  assert.deepEqual(parser.push(third.subarray(9)), [{ type: "response", seq: 3 }]);
  assert.equal(isTcpAdapterSpec("C:\\workspace\\fixture-adapter.mjs"), false);
  assert.equal(isTcpAdapterSpec("127.0.0.1:5678"), true);
  assert.deepEqual(
    tokenizeCommand('launch "C:\\workspace path\\adapter.mjs" \'C:\\program path\\app.py\' --debug'),
    ["launch", "C:\\workspace path\\adapter.mjs", "C:\\program path\\app.py", "--debug"],
  );
  assert.equal(tokenizeCommand('launch "C:\\workspace path\\adapter.mjs'), null);
  assert.deepEqual(parseBreakpointSpec("C:\\workspace path\\program.py:12"), {
    file: "C:\\workspace path\\program.py",
    line: 12,
  });
  assert.equal(parseBreakpointSpec("C:\\workspace path\\program.py:last"), null);
});

test("DAP rejected launch and configuration failure never report READY", { timeout: 15_000 }, async () => {
  const launchPaths = createFixtureRoot();
  const launchSession = startSession({
    DAP_FIXTURE_CAPTURE: launchPaths.capturePath,
    DAP_FIXTURE_LAUNCH_FAIL_ONCE_FILE: join(launchPaths.root, "fail-once.txt"),
  });
  try {
    const rejected = launchSession.waitFor(/^ERR: adapter-error$/m);
    launchSession.command(`launch "${launchPaths.adapter}" "C:\\workspace path\\program.py"`);
    await rejected;
    assert.doesNotMatch(launchSession.output(), /READY: launch/);

    const retryReady = launchSession.waitFor(/^READY: launch$/m);
    launchSession.command(`launch "${launchPaths.adapter}" "C:\\workspace path\\program.py"`);
    await retryReady;
  } finally {
    if (launchSession.child.exitCode === null) await quit(launchSession);
    rmSync(launchPaths.root, { recursive: true, force: true });
  }

  const configurationPaths = createFixtureRoot();
  const configurationSession = startSession({ DAP_FIXTURE_CONFIGURATION_FAILURE: "1" });
  try {
    const rejected = configurationSession.waitFor(/^ERR: adapter-error$/m);
    configurationSession.command(`launch "${configurationPaths.adapter}" "C:\\workspace path\\program.py"`);
    await rejected;
    assert.doesNotMatch(configurationSession.output(), /READY: launch/);
  } finally {
    if (configurationSession.child.exitCode === null) await quit(configurationSession);
    rmSync(configurationPaths.root, { recursive: true, force: true });
  }
});

test("DAP setup timeout preserves timeout classification without READY", { timeout: 15_000 }, async () => {
  const paths = createFixtureRoot();
  const session = startSession({ DAP_FIXTURE_NO_ANSWER: "1", DAP_TIMEOUT_MS: "2000" });
  try {
    const timedOut = session.waitFor(/^ERR: timeout$/m);
    session.command(`launch "${paths.adapter}" "C:\\workspace path\\program.py"`);
    await timedOut;
    assert.doesNotMatch(session.output(), /READY: launch/);
  } finally {
    if (session.child.exitCode === null) await quit(session);
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("DAP lldb rejected launch requires process or stopped corroboration", { timeout: 15_000 }, async () => {
  const paths = createFixtureRoot();
  const lldbAdapter = join(paths.root, "lldb-dap fixture.mjs");
  copyFileSync(paths.adapter, lldbAdapter);
  const session = startSession({ DAP_FIXTURE_LAUNCH_FAILURE: "1", DAP_FIXTURE_LAUNCH_PROCESS: "1" });
  try {
    const ready = session.waitFor(/^READY: launch$/m);
    session.command(`launch "${lldbAdapter}" "C:\\workspace path\\program.py"`);
    await ready;
  } finally {
    if (session.child.exitCode === null) await quit(session);
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("DAP lldb launch timeout with process corroboration never reaches READY", { timeout: 15_000 }, async () => {
  const paths = createFixtureRoot();
  const lldbAdapter = join(paths.root, "lldb-dap timeout fixture.mjs");
  copyFileSync(paths.adapter, lldbAdapter);
  const session = startSession({
    DAP_FIXTURE_LAUNCH_NO_RESPONSE: "1",
    DAP_FIXTURE_LAUNCH_PROCESS: "1",
    DAP_FIXTURE_LIFECYCLE: paths.lifecyclePath,
    DAP_TIMEOUT_MS: "2000",
  });
  try {
    const timedOut = session.waitFor(/^ERR: timeout$/m);
    session.command(`launch "${lldbAdapter}" "C:\\workspace path\\program.py"`);
    await timedOut;
    assert.doesNotMatch(session.output(), /READY: launch/);
    const adapterPid = fixturePid(paths.lifecyclePath);
    assert.throws(() => process.kill(adapterPid, 0), { code: "ESRCH" });
  } finally {
    if (session.child.exitCode === null) await quit(session);
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("DAP failed transport retry succeeds after connect failure", { timeout: 15_000 }, async () => {
  const paths = createFixtureRoot();
  const session = startSession();
  let tcpFixture;
  try {
    const badPort = await reserveUnusedLoopbackPort();
    const failed = session.waitFor(/^ERR: adapter-failed$/m);
    session.command(`attach 127.0.0.1:${badPort}`);
    await failed;

    tcpFixture = await startTcpFixture(paths);
    const ready = session.waitFor(/^READY: attach$/m);
    session.command(`attach 127.0.0.1:${tcpFixture.port}`);
    await ready;
  } finally {
    if (session.child.exitCode === null) await quit(session);
    if (tcpFixture) await stopFixture(tcpFixture.child);
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("DAP session overwrite rejection preserves launched adapter cleanup", { timeout: 15_000 }, async () => {
  const paths = createFixtureRoot();
  const session = startSession({ DAP_FIXTURE_LIFECYCLE: paths.lifecyclePath });
  try {
    const ready = session.waitFor(/^READY: launch$/m);
    session.command(`launch "${paths.adapter}" "C:\\workspace path\\program.py"`);
    await ready;
    const adapterPid = fixturePid(paths.lifecyclePath);

    const rejected = session.waitFor(/^ERR: adapter-error session already exists$/m);
    session.command("attach 127.0.0.1:1");
    await rejected;

    await quit(session);
    assert.throws(() => process.kill(adapterPid, 0), { code: "ESRCH" });
  } finally {
    if (session.child.exitCode === null) await quit(session);
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("DAP deferred attach initialized handshake reaches READY", { timeout: 15_000 }, async () => {
  const paths = createFixtureRoot();
  const tcpFixture = await startTcpFixture(paths);
  const session = startSession();
  try {
    const ready = session.waitFor(/^READY: attach$/m);
    session.command(`attach 127.0.0.1:${tcpFixture.port}`);
    await ready;
  } finally {
    if (session.child.exitCode === null) await quit(session);
    await stopFixture(tcpFixture.child);
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("DAP active transport disconnect reclaims child before attach retry", { timeout: 15_000 }, async () => {
  const paths = createFixtureRoot();
  const disconnectingFixture = await startTcpFixture(paths, {
    DAP_FIXTURE_CLOSE_PROTOCOL_AFTER_CONFIGURATION: "1",
  });
  const retryPaths = createFixtureRoot();
  const session = startSession();
  let retryFixture;
  try {
    const ready = session.waitFor(/^READY: launch$/m);
    const disconnected = session.waitFor(/^ERR: adapter-failed$/m);
    const fixtureExited = once(disconnectingFixture.child, "exit");
    session.command(`launch 127.0.0.1:${disconnectingFixture.port} "C:\\workspace path\\program.py"`);
    await ready;
    await disconnected;
    assert.equal((session.output().match(/^ERR: adapter-failed$/gm) ?? []).length, 1);
    await fixtureExited;

    retryFixture = await startTcpFixture(retryPaths);
    const attached = session.waitFor(/^READY: attach$/m);
    session.command(`attach 127.0.0.1:${retryFixture.port}`);
    await attached;
  } finally {
    if (session.child.exitCode === null) await quit(session);
    await stopFixture(disconnectingFixture.child);
    if (retryFixture) await stopFixture(retryFixture.child);
    rmSync(paths.root, { recursive: true, force: true });
    rmSync(retryPaths.root, { recursive: true, force: true });
  }
});

test("DAP terminal close reports one EXIT and no adapter failure", { timeout: 15_000 }, async () => {
  const paths = createFixtureRoot();
  const tcpFixture = await startTcpFixture(paths, { DAP_FIXTURE_CLOSE_PROTOCOL_AFTER_TERMINATE: "1" });
  const session = startSession();
  try {
    const ready = session.waitFor(/^READY: launch$/m);
    session.command(`launch 127.0.0.1:${tcpFixture.port} "C:\\workspace path\\program.py"`);
    await ready;

    const fixtureExited = once(tcpFixture.child, "exit");
    const exited = session.waitFor(/^EXIT: terminated$/m);
    session.command("terminate");
    await exited;
    await fixtureExited;
    assert.equal((session.output().match(/^EXIT: terminated$/gm) ?? []).length, 1);
    assert.doesNotMatch(session.output(), /^ERR: adapter-failed$/m);

    await quit(session);
  } finally {
    if (session.child.exitCode === null) await quit(session);
    await stopFixture(tcpFixture.child);
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("DAP launch setup terminal reports one EXIT without READY or ERR", { timeout: 15_000 }, async () => {
  const paths = createFixtureRoot();
  const tcpFixture = await startTcpFixture(paths, { DAP_FIXTURE_TERMINATE_AFTER_CONFIGURATION: "1" });
  const session = startSession();
  try {
    const fixtureExited = once(tcpFixture.child, "exit");
    const exited = session.waitFor(/^EXIT: terminated$/m);
    session.command(`launch 127.0.0.1:${tcpFixture.port} "C:\\workspace path\\program.py"`);
    await exited;
    await fixtureExited;
    assert.equal((session.output().match(/^EXIT: terminated$/gm) ?? []).length, 1);
    assert.doesNotMatch(session.output(), /^READY: launch$/m);
    assert.doesNotMatch(session.output(), /^ERR:/m);

    await quit(session);
  } finally {
    if (session.child.exitCode === null) await quit(session);
    await stopFixture(tcpFixture.child);
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("DAP attach setup terminal reports one EXIT without READY or ERR", { timeout: 15_000 }, async () => {
  const paths = createFixtureRoot();
  const tcpFixture = await startTcpFixture(paths, { DAP_FIXTURE_TERMINATE_AFTER_CONFIGURATION: "1" });
  const session = startSession();
  try {
    const fixtureExited = once(tcpFixture.child, "exit");
    const exited = session.waitFor(/^EXIT: terminated$/m);
    session.command(`attach 127.0.0.1:${tcpFixture.port}`);
    await exited;
    await fixtureExited;
    assert.equal((session.output().match(/^EXIT: terminated$/gm) ?? []).length, 1);
    assert.doesNotMatch(session.output(), /^READY: attach$/m);
    assert.doesNotMatch(session.output(), /^ERR:/m);

    await quit(session);
  } finally {
    if (session.child.exitCode === null) await quit(session);
    await stopFixture(tcpFixture.child);
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("DAP snapshot transport loss reports one adapter failure", { timeout: 15_000 }, async () => {
  const paths = createFixtureRoot();
  const tcpFixture = await startTcpFixture(paths, { DAP_FIXTURE_CLOSE_PROTOCOL_ON_STACK_TRACE: "1" });
  const session = startSession();
  try {
    const ready = session.waitFor(/^READY: launch$/m);
    session.command(`launch 127.0.0.1:${tcpFixture.port} "C:\\workspace path\\program.py"`);
    await ready;

    const fixtureExited = once(tcpFixture.child, "exit");
    const failed = session.waitFor(/^ERR: adapter-failed$/m);
    session.command("continue");
    await failed;
    await fixtureExited;
    assert.equal((session.output().match(/^ERR: adapter-failed$/gm) ?? []).length, 1);
    assert.doesNotMatch(session.output(), /^STOP:/m);

    await quit(session);
  } finally {
    if (session.child.exitCode === null) await quit(session);
    await stopFixture(tcpFixture.child);
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("DAP required no-stop timeout emits no STOP", { timeout: 15_000 }, async () => {
  const paths = createFixtureRoot();
  const session = startSession({ DAP_FIXTURE_NO_STOP: "1", DAP_TIMEOUT_MS: "2000" });
  try {
    const ready = session.waitFor(/^READY: launch$/m);
    session.command(`launch "${paths.adapter}" "C:\\workspace path\\program.py"`);
    await ready;

    const outputStart = session.output().length;
    const timedOut = session.waitFor(/^ERR: timeout$/m);
    session.command("continue");
    await timedOut;
    assert.doesNotMatch(session.output().slice(outputStart), /^STOP:/m);
  } finally {
    if (session.child.exitCode === null) await quit(session);
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("DAP oversized eval/stack output stays within 32KB", { timeout: 15_000 }, async () => {
  const paths = createFixtureRoot();
  const session = startSession({ DAP_FIXTURE_OVERSIZED_OUTPUT: "1" });
  try {
    const ready = session.waitFor(/^READY: launch$/m);
    session.command(`launch "${paths.adapter}" "C:\\workspace path\\program.py"`);
    await ready;

    const stopStart = session.output().length;
    const stopped = session.waitFor(/^STOP: /m);
    const stopTruncated = session.waitFor(/^TRUNCATED: bytes dropped=\d+$/m);
    session.command("continue");
    await Promise.all([stopped, stopTruncated]);
    assertOutputLinesBounded(session.output().slice(stopStart));

    const stackStart = session.output().length;
    const stackTruncated = session.waitFor(/^TRUNCATED: rows dropped=\d+ bytes dropped=\d+$/m);
    session.command("stack");
    await stackTruncated;
    assertOutputLinesBounded(session.output().slice(stackStart));

    const evalStart = session.output().length;
    const evaluated = session.waitFor(/^EVAL\t/m);
    const evalTruncated = session.waitFor(/^TRUNCATED: bytes dropped=\d+$/m);
    session.command("eval value");
    await Promise.all([evaluated, evalTruncated]);
    assertOutputLinesBounded(session.output().slice(evalStart));
  } finally {
    if (session.child.exitCode === null) await quit(session);
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("DAP REPL keeps quoted Windows paths, invalid launch args, and table caps", { timeout: 15_000 }, async () => {
  const paths = createFixtureRoot();
  const session = startSession({ DAP_FIXTURE_CAPTURE: paths.capturePath, DAP_FIXTURE_LIFECYCLE: paths.lifecyclePath });
  try {
    const missingAdapter = session.waitFor(/^ERR: invalid-args$/m);
    session.command("launch");
    await missingAdapter;

    const missingProgram = session.waitFor(/^ERR: invalid-args$/m);
    session.command('launch "C:\\workspace path\\adapter.mjs"');
    await missingProgram;

    const unclosedQuote = session.waitFor(/^ERR: invalid-args$/m);
    session.command('launch "C:\\workspace path\\adapter.mjs');
    await unclosedQuote;

    const ready = session.waitFor(/^READY: launch$/m);
    session.command(`launch "${paths.adapter}" "C:\\workspace path\\program.py"`);
    await ready;
    const launchArguments = JSON.parse(readFileSync(paths.capturePath, "utf8").trim());
    assert.equal(launchArguments.program, "C:\\workspace path\\program.py");

    const breakpoint = session.waitFor(/^BREAK: C:\\workspace path\\program\.py:12$/m);
    session.command('break "C:\\workspace path\\program.py:12"');
    await breakpoint;

    const truncated = session.waitFor(/^TRUNCATED: rows dropped=\d+ bytes dropped=\d+$/m);
    session.command("vars 8");
    await truncated;
    const rowCount = (session.output().match(/^v\d+\t/gm) ?? []).length;
    assert.ok(rowCount > 0 && rowCount <= 100, `expected at most ${100} variable rows, got ${rowCount}`);
  } finally {
    if (session.child.exitCode === null) await quit(session);
    rmSync(paths.root, { recursive: true, force: true });
  }
});
