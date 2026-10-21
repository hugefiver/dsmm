#!/usr/bin/env node
// Deterministic DAP fixture used by dap.test.mjs.
import { appendFileSync, closeSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { stdin, stdout, env } from "node:process";

let seq = 1;
const capturePath = process.env.DAP_FIXTURE_CAPTURE;
const lifecyclePath = process.env.DAP_FIXTURE_LIFECYCLE;
const tcpPortPath = env.DAP_FIXTURE_TCP_PORT_FILE;
const failOncePath = env.DAP_FIXTURE_LAUNCH_FAIL_ONCE_FILE;
const noAnswer = env.DAP_FIXTURE_NO_ANSWER === "1";
const launchFailure = env.DAP_FIXTURE_LAUNCH_FAILURE === "1";
const configurationFailure = env.DAP_FIXTURE_CONFIGURATION_FAILURE === "1";
const noStop = env.DAP_FIXTURE_NO_STOP === "1";
const oversizedOutput = env.DAP_FIXTURE_OVERSIZED_OUTPUT === "1";
const closeProtocolAfterConfiguration = env.DAP_FIXTURE_CLOSE_PROTOCOL_AFTER_CONFIGURATION === "1";
const launchNoResponse = env.DAP_FIXTURE_LAUNCH_NO_RESPONSE === "1";
const closeProtocolAfterTerminate = env.DAP_FIXTURE_CLOSE_PROTOCOL_AFTER_TERMINATE === "1";
const closeProtocolOnStackTrace = env.DAP_FIXTURE_CLOSE_PROTOCOL_ON_STACK_TRACE === "1";
const terminateAfterConfiguration = env.DAP_FIXTURE_TERMINATE_AFTER_CONFIGURATION === "1";

function record(path, value) {
  if (path) appendFileSync(path, `${value}\n`);
}

if (lifecyclePath) writeFileSync(lifecyclePath, `started ${process.pid}\n`);
process.once("SIGTERM", () => {
  record(lifecyclePath, "sigterm");
  process.exit(0);
});
process.once("exit", () => record(lifecyclePath, "exit"));

function shouldFailLaunchOnce() {
  if (!failOncePath) return false;
  try {
    writeFileSync(failOncePath, "failed\n", { flag: "wx" });
    return true;
  } catch (cause) {
    if (cause?.code === "EEXIST") return false;
    throw cause;
  }
}

function createEndpoint(input, output, deferInitialized) {
  let endpointBuffer = Buffer.alloc(0);
  const oversized = "x".repeat(40 * 1024);

  function frame(message) {
    const body = Buffer.from(JSON.stringify(message));
    return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
  }
  function send(message) {
    output.write(frame(message));
  }
  function response(request, body = {}, success = true, message) {
    send({ type: "response", seq: seq++, request_seq: request.seq, success, command: request.command, body, ...(message ? { message } : {}) });
  }
  function event(eventName, body = {}) { send({ type: "event", seq: seq++, event: eventName, body }); }
  function closeProtocol() {
    setImmediate(() => {
      record(lifecyclePath, "protocol-close");
      if (tcpPortPath) output.end?.();
      else {
        try { closeSync(1); } catch { /* fixture may already have closed stdout */ }
        output.destroy?.();
      }
    });
  }
  function handle(request) {
    switch (request.command) {
    case "initialize":
      if (noAnswer) return;
      response(request, { supportsConfigurationDoneRequest: true, supportsEvaluateForHovers: true });
      if (!deferInitialized) event("initialized");
      break;
    case "setBreakpoints": {
      const bps = request.arguments?.breakpoints ?? [];
      response(request, { breakpoints: bps.map((bp, index) => ({ id: index + 1, verified: !request.arguments?.source?.path?.includes("unverified"), line: bp.line, column: bp.column ?? 1, message: "fixture" })) });
      break;
    }
    case "configurationDone":
      if (!configurationFailure && terminateAfterConfiguration) {
        const configured = { type: "response", seq: seq++, request_seq: request.seq, success: true, command: request.command, body: {} };
        const terminal = { type: "event", seq: seq++, event: "terminated", body: {} };
        output.write(Buffer.concat([frame(configured), frame(terminal)]));
        closeProtocol();
      } else {
        response(request, {}, !configurationFailure, configurationFailure ? "configuration failed" : undefined);
        if (!configurationFailure && closeProtocolAfterConfiguration) closeProtocol();
      }
      break;
    case "launch":
      record(capturePath, JSON.stringify(request.arguments));
      if (deferInitialized) event("initialized");
      if (launchNoResponse) {
        if (env.DAP_FIXTURE_LAUNCH_PROCESS === "1") event("process", { name: "fixture" });
        if (env.DAP_FIXTURE_LAUNCH_STOP === "1") event("stopped", { reason: "entry", threadId: 1, allThreadsStopped: true });
        break;
      }
      if (launchFailure || shouldFailLaunchOnce()) {
        response(request, {}, false, "launch failed");
        if (env.DAP_FIXTURE_LAUNCH_PROCESS === "1") event("process", { name: "fixture" });
        if (env.DAP_FIXTURE_LAUNCH_STOP === "1") event("stopped", { reason: "entry", threadId: 1, allThreadsStopped: true });
        break;
      }
      response(request);
      event("stopped", { reason: "entry", threadId: 1, allThreadsStopped: true });
      break;
    case "attach": response(request, { }); if (deferInitialized) event("initialized"); break;
    case "continue":
      response(request, { allThreadsContinued: true });
      if (!noStop) event("stopped", { reason: oversizedOutput ? oversized : "breakpoint", threadId: 1, allThreadsStopped: true });
      break;
    case "next": case "stepIn": case "stepOut": response(request); event("stopped", { reason: "step", threadId: 1 }); break;
    case "pause": response(request); event("stopped", { reason: "pause", threadId: 1 }); break;
    case "threads": response(request, { threads: [{ id: 1, name: "main" }] }); break;
    case "stackTrace":
      if (closeProtocolOnStackTrace) { closeProtocol(); break; }
      response(request, { stackFrames: [{ id: 42, name: oversizedOutput ? oversized : "main", source: { path: oversizedOutput ? `/tmp/${oversized}.py` : "/tmp/program.py" }, line: 12, column: 3 }] });
      break;
    case "scopes": response(request, { scopes: [{ name: "Locals", variablesReference: 7, expensive: false }] }); break;
    case "variables": response(request, { variables: Array.from({ length: 250 }, (_, index) => ({ name: `v${index + 1}`, value: request.arguments?.variablesReference === 8 ? `${String(index + 1)} ${"x".repeat(500)}` : String(index + 1), variablesReference: 0 })) }); break;
    case "evaluate": response(request, { result: oversizedOutput ? oversized : "42", type: "int", variablesReference: 0 }); break;
    case "terminate":
      response(request);
      event("terminated", {});
      if (closeProtocolAfterTerminate) closeProtocol();
      break;
    default: response(request, {}, false, `unsupported ${request.command}`);
    }
  }
  input.on("data", chunk => {
    endpointBuffer = Buffer.concat([endpointBuffer, chunk]);
    while (true) {
      const marker = endpointBuffer.indexOf(Buffer.from("\r\n\r\n"));
      if (marker < 0) return;
      const header = endpointBuffer.subarray(0, marker).toString();
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) { endpointBuffer = endpointBuffer.subarray(marker + 4); continue; }
      const length = Number(match[1]);
      const start = marker + 4;
      if (endpointBuffer.length < start + length) return;
      const body = endpointBuffer.subarray(start, start + length);
      endpointBuffer = endpointBuffer.subarray(start + length);
      try { handle(JSON.parse(body.toString("utf8"))); } catch { /* fixture input is controlled */ }
    }
  });
}

if (tcpPortPath) {
  const server = createServer(socket => {
    createEndpoint(socket, socket, true);
    if (closeProtocolAfterConfiguration || closeProtocolAfterTerminate || closeProtocolOnStackTrace || terminateAfterConfiguration) {
      socket.once("close", () => server.close());
    }
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (address && typeof address !== "string") writeFileSync(tcpPortPath, String(address.port));
  });
} else {
  createEndpoint(stdin, stdout, false);
}
