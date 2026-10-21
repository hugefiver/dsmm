#!/usr/bin/env node
// Zero-dependency DAP REPL, modeled on oh-my-pi's debug tool. DAP framing is UTF-8 byte based.
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { stdin, stdout, stderr, env } from "node:process";
import { pathToFileURL } from "node:url";

export const MAX_ROWS = 100;
export const MAX_OUTPUT_BYTES = 32 * 1024;

export function isTcpAdapterSpec(spec) {
  if (typeof spec !== "string") return false;
  const separator = spec.lastIndexOf(":");
  return separator > 0 &&
    !spec.includes("/") &&
    !spec.includes("\\") &&
    /^\d+$/.test(spec.slice(separator + 1));
}

export function tokenizeCommand(input) {
  const tokens = [];
  let token = "";
  let quote = null;
  let tokenStarted = false;

  for (const character of input.trim()) {
    if (quote) {
      if (character === quote) quote = null;
      else token += character;
      tokenStarted = true;
    } else if (character === "\"" || character === "'") {
      quote = character;
      tokenStarted = true;
    } else if (/\s/.test(character)) {
      if (tokenStarted) {
        tokens.push(token);
        token = "";
        tokenStarted = false;
      }
    } else {
      token += character;
      tokenStarted = true;
    }
  }

  if (quote) return null;
  if (tokenStarted) tokens.push(token);
  return tokens;
}

export function parseBreakpointSpec(spec) {
  if (typeof spec !== "string") return null;
  const match = /^(.*):(\d+)$/.exec(spec);
  if (!match || !match[1]) return null;
  return { file: match[1], line: Number(match[2]) };
}

export class DapFrameParser {
  constructor() { this.buffer = Buffer.alloc(0); }
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    const messages = [];
    while (true) {
      const marker = this.buffer.indexOf(Buffer.from("\r\n\r\n"));
      if (marker < 0) break;
      const header = this.buffer.subarray(0, marker).toString("ascii");
      const match = header.match(/(?:^|\r\n)Content-Length:\s*(\d+)/i);
      if (!match) { this.buffer = this.buffer.subarray(marker + 4); continue; }
      const length = Number(match[1]);
      const start = marker + 4;
      if (this.buffer.length < start + length) break;
      const body = this.buffer.subarray(start, start + length);
      this.buffer = this.buffer.subarray(start + length);
      try { messages.push(JSON.parse(body.toString("utf8"))); } catch { /* malformed frames are ignored */ }
    }
    return messages;
  }
}

const timeoutMs = Number(env.DAP_TIMEOUT_MS || 15000);
let transport = null;
let ownedCleanup = null;
let cleanupPromise = null;
let parser = null;
let nextSeq = 1;
let initialized = false;
let terminated = false;
let exitReported = false;
let currentStop = null;
let topFrame = null;
let processStarted = false;
let sessionFailure = null;
let setupTerminal = null;
const pending = new Map();
const breakpoints = new Map();
// Event-driven waits. A tight `await setImmediate` busy-loop starves Bun's socket
// data callbacks (the `initialized` event then never processes and launch deadlocks),
// so every wait subscribes to the actual DAP event instead of polling state.
const eventWaiters = new Map();
function onEvent(name) {
  if (sessionFailure) return Promise.reject(sessionFailure);
  return new Promise((resolve, reject) => {
    const list = eventWaiters.get(name) || [];
    list.push({ resolve, reject });
    eventWaiters.set(name, list);
  });
}
function emitEvent(name, value) {
  const list = eventWaiters.get(name) || [];
  eventWaiters.delete(name);
  for (const wait of list) wait.resolve(value);
}
function rejectEventWaiters(cause) {
  for (const list of eventWaiters.values()) {
    for (const wait of list) wait.reject(cause);
  }
  eventWaiters.clear();
}
function wakeEventWaiters(value) {
  for (const list of eventWaiters.values()) {
    for (const wait of list) wait.resolve(value);
  }
  eventWaiters.clear();
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function errorKind(cause) {
  return cause?.message === "timeout" ? "timeout" : cause?.message === "adapter-error" ? "adapter-error" : "adapter-failed";
}

function rejectPending(cause) {
  const error = typeof cause === "string" ? new Error(cause) : cause;
  for (const wait of pending.values()) wait.reject(error);
  pending.clear();
}

function resetSessionState(cause = new Error("adapter-failed")) {
  rejectPending(cause);
  rejectEventWaiters(cause);
  transport = null;
  parser = null;
  nextSeq = 1;
  initialized = false;
  terminated = false;
  exitReported = false;
  currentStop = null;
  topFrame = null;
  processStarted = false;
  sessionFailure = cause?.reported ? cause : null;
  breakpoints.clear();
}

function reclaimSession(cause = new Error("adapter-failed")) {
  if (cleanupPromise) return cleanupPromise;
  const cleanup = transport?.cleanup ?? ownedCleanup;
  transport = null;
  ownedCleanup = null;
  resetSessionState(cause);
  const reclaim = (async () => {
    try {
      if (cleanup) await cleanup();
    } catch {
      // Cleanup is fail-closed: state is already reset and retries must not hang.
    }
  })();
  cleanupPromise = reclaim;
  reclaim.then(() => {
    if (cleanupPromise === reclaim) cleanupPromise = null;
  });
  return reclaim;
}

async function cleanupSession(cause) {
  await reclaimSession(cause);
}

async function waitForCleanup() {
  if (cleanupPromise) await cleanupPromise;
}

function throwIfSessionFailed() {
  if (sessionFailure) throw sessionFailure;
}

function throwIfSetupTerminated() {
  if (setupTerminal) throw setupTerminal;
}

function beginSetup() {
  setupTerminal = null;
  sessionFailure = null;
}

const debugTraffic = Boolean(env.DAP_DEBUG);
function trace(direction, message) { if (debugTraffic) stderr.write(`DAP ${direction} ${JSON.stringify(message).slice(0, 300)}\n`); }
function line(text) { stdout.write(`${text}\n`); }
function error(kind, detail = "") { line(`ERR: ${kind}${detail ? ` ${detail}` : ""}`); }
function reportExit() {
  if (exitReported || setupTerminal?.exitReported) return;
  exitReported = true;
  if (setupTerminal) setupTerminal.exitReported = true;
  line("EXIT: terminated");
}
function markTerminated() {
  setupTerminal ??= Object.assign(new Error("terminated"), { reported: true, exitReported: false });
  terminated = true;
  currentStop = null;
  rejectPending(setupTerminal);
  wakeEventWaiters(setupTerminal);
  reportExit();
}

function truncateUtf8(value, maxBytes) {
  const source = String(value ?? "");
  const totalBytes = Buffer.byteLength(source);
  if (totalBytes <= maxBytes) return { text: source, droppedBytes: 0 };
  let text = "";
  let usedBytes = 0;
  for (const character of source) {
    const characterBytes = Buffer.byteLength(character);
    if (usedBytes + characterBytes > maxBytes) break;
    text += character;
    usedBytes += characterBytes;
  }
  return { text, droppedBytes: totalBytes - usedBytes };
}

function writeBoundedAdapterLine(prefix, value) {
  const availableBytes = Math.max(0, MAX_OUTPUT_BYTES - Buffer.byteLength(prefix) - 1);
  const truncated = truncateUtf8(value, availableBytes);
  stdout.write(`${prefix}${truncated.text}\n`);
  if (truncated.droppedBytes > 0) line(`TRUNCATED: bytes dropped=${truncated.droppedBytes}`);
}

function send(message) {
  trace(">", message);
  const body = Buffer.from(JSON.stringify(message));
  transport.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
}
function request(command, args = {}) {
  if (setupTerminal) return Promise.reject(setupTerminal);
  if (sessionFailure) return Promise.reject(sessionFailure);
  if (!transport || terminated) return Promise.reject(new Error("no-session"));
  const seq = nextSeq++;
  send({ type: "request", seq, command, arguments: args });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(seq); reject(new Error("timeout")); }, timeoutMs);
    pending.set(seq, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: value => { clearTimeout(timer); reject(value); } });
  });
}
function onMessage(message) {
  trace("<", message);
  if (message.type === "response") {
    const wait = pending.get(message.request_seq);
    if (!wait) return;
    pending.delete(message.request_seq);
    if (message.success === false) wait.reject(new Error("adapter-error")); else wait.resolve(message);
  } else if (message.type === "event") {
    if (message.event === "initialized") { initialized = true; emitEvent("initialized"); }
    if (message.event === "stopped") { currentStop = message.body || {}; emitEvent("stopped", currentStop); }
    if (message.event === "process") { processStarted = true; emitEvent("process"); }
    if (message.event === "terminated" || message.event === "exited") markTerminated();
  }
}
function connectTransport(write, read, cleanup) {
  const active = { write: chunk => write.write(chunk), cleanup };
  transport = active;
  ownedCleanup = cleanup;
  const activeParser = new DapFrameParser();
  parser = activeParser;
  read.on("data", chunk => {
    if (transport !== active) return;
    for (const message of activeParser.push(chunk)) onMessage(message);
  });
  const failTransport = () => {
    if (transport !== active || cleanupPromise) return;
    if (terminated) {
      void cleanupSession();
      return;
    }
    const cause = Object.assign(new Error("adapter-failed"), { reported: true });
    void cleanupSession(cause);
    error("adapter-failed");
  };
  read.on("error", failTransport);
  read.on("end", failTransport);
  read.on("close", failTransport);
}
function connectSocket(socket) { connectTransport(socket, socket, () => socket.destroy()); }
async function startAdapter(spec) {
  if (isTcpAdapterSpec(spec)) {
    const separator = spec.lastIndexOf(":");
    const socket = createConnection(Number(spec.slice(separator + 1)), spec.slice(0, separator));
    try {
      await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
      connectSocket(socket);
    } catch (cause) {
      socket.destroy();
      throw cause;
    }
  } else {
    // A .mjs/.cjs/.js adapter spec runs under the current Bun/Node runtime (for
    // example, the fixture adapter). Bun also accepts .ts; native Node does not
    // rely on TypeScript execution here. Other specs are adapter executables.
    const isScript = /\.(mjs|cjs|js)$/.test(spec) || (Boolean(process.versions.bun) && /\.ts$/.test(spec));
    const [cmd, argv] = isScript ? [process.execPath, [spec]] : [spec, []];
    const child = spawn(cmd, argv, { stdio: ["pipe", "pipe", "inherit"] });
    try {
      await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    } catch (cause) {
      child.kill();
      throw cause;
    }
    connectTransport(child.stdin, child.stdout, () => {
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
      return new Promise(resolve => {
        child.once("exit", resolve);
        child.kill();
      });
    });
  }
}
// Waits for a stopped event. When `required` is false this is a best-effort grace
// window (e.g. an optional stop-on-entry); it returns on the first stop OR on timeout
// without failing, so adapters that run straight to a breakpoint are not broken.
async function waitForStop(required = true, graceMs) {
  throwIfSessionFailed();
  if (currentStop || terminated) return Boolean(currentStop);
  const budget = graceMs ?? timeoutMs;
  await Promise.race([onEvent("stopped"), onEvent("terminated"), sleep(budget)]);
  throwIfSessionFailed();
  if (required && !currentStop && !terminated) throw new Error("timeout");
  return Boolean(currentStop);
}
// Waits for the adapter's `initialized` event, event-driven (never a busy-loop).
async function waitInitialized() {
  throwIfSetupTerminated();
  throwIfSessionFailed();
  if (initialized) return;
  await Promise.race([onEvent("initialized"), sleep(timeoutMs)]);
  throwIfSetupTerminated();
  throwIfSessionFailed();
  if (!initialized) throw new Error("timeout");
}
// Adapters gate the `initialized` event on a recognized adapterID (debugpy withholds
// it for unknown IDs, hanging the handshake). Infer a known ID from the adapter spec.
function adapterIdFor(spec) {
  const base = String(spec).split(/[\\/]/).pop().toLowerCase();
  if (base.includes("debugpy") || base.includes("python")) return "debugpy";
  if (base.includes("lldb")) return "lldb-dap";
  if (base.includes("dlv") || base.includes("delve")) return "dlv";
  if (base.includes("js-debug")) return "js-debug";
  if (base.includes("gdb")) return "gdb";
  return "dsmm";
}

async function confirmLldbLaunch() {
  throwIfSetupTerminated();
  throwIfSessionFailed();
  if (processStarted || currentStop) return true;
  await Promise.race([onEvent("process"), onEvent("stopped"), onEvent("terminated"), sleep(timeoutMs)]);
  throwIfSetupTerminated();
  throwIfSessionFailed();
  return processStarted || Boolean(currentStop);
}

async function launch(adapter, program, args) {
  await waitForCleanup();
  if (transport) return error("adapter-error", "session already exists");
  beginSetup();
  try {
    await startAdapter(adapter);
    throwIfSetupTerminated();
    const adapterID = adapterIdFor(adapter);
    await request("initialize", { clientID: "dsmm-dap", adapterID, linesStartAt1: true, columnsStartAt1: true, pathFormat: "path" });
    throwIfSetupTerminated();
    // Send launch BEFORE awaiting `initialized`: debugpy's adapter defers/flushes the
    // initialized event until further client activity, so waiting for it first
    // deadlocks the handshake. DAP allows launch any time after the initialize
    // response; `initialized` is only required before configurationDone.
    // stopOnEntry yields an initial stopped event with a real threadId, so the client
    // can set breakpoints and inspect from a valid stopped state before continuing.
    // `console: "internalConsole"` is REQUIRED by debugpy (without it the launch never
    // spawns the debug server -> "Server is not available"); lldb-dap ignores it.
    // lldb-dap reports the launch response success unreliably (false even when the
    // process started and stopped); the process/stopped EVENTS are the real signal,
    // so a non-success launch response is tolerated, not fatal.
    try {
      await request("launch", { program, args, console: "internalConsole", justMyCode: false, stopOnEntry: true });
      throwIfSetupTerminated();
    } catch (cause) {
      throwIfSetupTerminated();
      if (adapterID !== "lldb-dap" || cause?.message !== "adapter-error" || !await confirmLldbLaunch()) throw cause;
    }
    await waitInitialized();
    throwIfSetupTerminated();
    await request("configurationDone");
    throwIfSetupTerminated();
    // Best-effort: lldb-dap stops at entry, other adapters run to the first breakpoint.
    await waitForStop(false, 2000);
    throwIfSetupTerminated();
    throwIfSessionFailed();
    line("READY: launch");
  } catch (cause) {
    await cleanupSession();
    if (!cause?.reported && !setupTerminal) error(errorKind(cause));
  }
}
async function snapshot() {
  if (terminated) { reportExit(); return; }
  if (!currentStop) return;
  try {
    const response = await request("stackTrace", { threadId: currentStop?.threadId || 1, levels: 1 });
    topFrame = response.body?.stackFrames?.[0];
    const f = topFrame;
    if (f) writeBoundedAdapterLine("STOP: ", `stopped reason=${currentStop?.reason || "unknown"} threadId=${currentStop?.threadId || ""} ${f.name} at ${f.source?.path || "?"}:${f.line || 0}:${f.column || 0}`);
    else writeBoundedAdapterLine("STOP: ", `stopped reason=${currentStop?.reason || "unknown"} threadId=${currentStop?.threadId || ""} ? at ?:0:0`);
  } catch (cause) { if (!cause?.reported) error(errorKind(cause)); }
}
function boundedTable(header, rows) {
  const all = rows.map(row => row.join("\t"));
  const chosen = all.slice(0, MAX_ROWS);
  const prefix = `${header.join("\t")}\n`;
  let output = prefix;
  let count = 0;
  for (const row of chosen) {
    const candidate = `${row}\n`;
    if (Buffer.byteLength(output + candidate) > MAX_OUTPUT_BYTES) break;
    output += candidate; count++;
  }
  stdout.write(output);
  const rowDropped = all.length - count;
  const byteDropped = Buffer.byteLength(all.slice(count).join("\n") + (all.length > count ? "\n" : ""));
  if (rowDropped > 0 || byteDropped > 0) line(`TRUNCATED: rows dropped=${rowDropped} bytes dropped=${byteDropped}`);
}
async function command(input) {
  const parts = tokenizeCommand(input);
  if (!parts) return error("invalid-args");
  const cmd = parts.shift();
  if (!cmd) return;
  if (cmd === "quit") { await cleanupSession(); process.exit(0); }
  if (cmd === "launch") {
    const adapter = parts.shift();
    const program = parts.shift();
    if (!adapter || !program) return error("invalid-args");
    return launch(adapter, program, parts);
  }
  if (cmd === "attach") {
    await waitForCleanup();
    if (transport) return error("adapter-error", "session already exists");
    beginSetup();
    const endpoint = parts.shift();
    if (!isTcpAdapterSpec(endpoint)) return error("invalid-args");
    try {
      await startAdapter(endpoint);
      throwIfSetupTerminated();
      await request("initialize", { clientID: "dsmm-dap", adapterID: "debugpy", linesStartAt1: true, columnsStartAt1: true, pathFormat: "path" });
      throwIfSetupTerminated();
      await request("attach", { justMyCode: false });
      throwIfSetupTerminated();
      await waitInitialized();
      throwIfSetupTerminated();
      await request("configurationDone");
      throwIfSetupTerminated();
      line("READY: attach");
    } catch (cause) {
      await cleanupSession();
      if (!cause?.reported && !setupTerminal) error(errorKind(cause));
    }
    return;
  }
  if (!transport) return error("no-session");
  try {
    if (cmd === "break" || cmd === "rmbreak") {
      const breakpoint = parseBreakpointSpec(parts[0]);
      if (!breakpoint) return error("invalid-args");
      const { file, line: lineNumber } = breakpoint;
      const set = breakpoints.get(file) || [];
      const next = cmd === "break" ? [...set.filter(x => x.line !== lineNumber), { line: lineNumber }] : set.filter(x => x.line !== lineNumber);
      const response = await request("setBreakpoints", { source: { path: file }, breakpoints: next });
      breakpoints.set(file, next);
      if (response.body?.breakpoints?.some(bp => bp.verified === false)) error("unverified-breakpoint"); else line(`BREAK: ${file}:${lineNumber}`);
    } else if (["continue", "step", "next", "stepin", "stepout", "pause"].includes(cmd)) {
      const dapCmd = { step: "next", stepin: "stepIn", stepout: "stepOut" }[cmd] || cmd;
      const threadId = currentStop?.threadId || 1;
      currentStop = null;
      await request(dapCmd, { threadId });
      // Wait for the resulting stopped event (breakpoint hit / step completed) before
      // snapshotting; without this the stack is read while the debuggee is still running.
      if (await waitForStop()) await snapshot();
      else if (terminated) reportExit();
    } else if (cmd === "stack") {
      const r = await request("stackTrace", { threadId: currentStop?.threadId || 1, levels: Number(parts[0]) || 100 });
      boundedTable(["FRAME", "NAME", "FILE", "LINE", "COLUMN"], (r.body?.stackFrames || []).map(f => [String(f.id), f.name, f.source?.path || "", String(f.line || ""), String(f.column || "")]));
    } else if (cmd === "scopes") {
      const r = await request("scopes", { frameId: topFrame?.id || 42 });
      boundedTable(["NAME", "VARIABLES_REFERENCE"], (r.body?.scopes || []).map(s => [s.name, String(s.variablesReference)]));
    } else if (cmd === "vars") {
      if (!parts[0]) return error("invalid-args");
      const r = await request("variables", { variablesReference: Number(parts[0]) });
      boundedTable(["NAME", "VALUE"], (r.body?.variables || []).map(v => [v.name, v.value ?? ""]));
    } else if (cmd === "eval") {
      if (!parts.length) return error("invalid-args");
      const r = await request("evaluate", { expression: parts.join(" "), frameId: topFrame?.id || 42 });
      writeBoundedAdapterLine("EVAL\t", r.body?.result ?? "");
    } else if (cmd === "threads") {
      const r = await request("threads"); boundedTable(["ID", "NAME"], (r.body?.threads || []).map(t => [String(t.id), t.name]));
    } else if (cmd === "sessions") line("SESSION\tSTATE\n1\tactive");
    else if (cmd === "terminate") {
      await request("terminate", { restart: false });
      markTerminated();
      await cleanupSession();
    }
    else error("invalid-args");
  } catch (cause) { if (!cause?.reported) error(errorKind(cause)); }
}

function isMainModule() {
  if (typeof import.meta.main === "boolean") return import.meta.main;
  const entrypoint = process.argv[1];
  return typeof entrypoint === "string" && pathToFileURL(resolve(entrypoint)).href === import.meta.url;
}

if (isMainModule()) {
  // Serialize stdin commands: fire-and-forget (`void command(...)`) lets a `continue`
  // race ahead of the launch handshake's configurationDone, and the adapter then
  // drops or rejects the out-of-order request. Each line awaits the previous command.
  let chain = Promise.resolve();
  const rl = createInterface({ input: stdin, crlfDelay: Infinity });
  rl.on("line", value => { chain = chain.then(() => command(value)).catch(() => {}); });
}
