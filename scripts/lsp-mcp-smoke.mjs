import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDiagnosticWorkspace } from "./lsp-smoke-fixture.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = process.env.DSMM_LSP_PACKAGE_ROOT === undefined ? root : resolve(process.env.DSMM_LSP_PACKAGE_ROOT);
const entry = process.env.DSMM_LSP_PACKAGE_ROOT === undefined ? "index.js" : "lsp.js";
const dsmm = await import(pathToFileURL(join(packageRoot, "lib", entry)).href);
const fallback = ["ocmm-lsp", "mcp"];
const command = dsmm.parseLspSmokeCommand(process.env.DSMM_LSP_COMMAND_JSON ?? process.env.DSMM_LSP_COMMAND, fallback);
const fixture = createDiagnosticWorkspace();

const child = spawn(command[0], command.slice(1), {
  cwd: fixture.root,
  env: { ...process.env, ...fixture.env },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true
});
const stderr = [];
child.stderr.on("data", (chunk) => stderr.push(chunk));

const reader = createLineReader(child.stdout);

try {
  await request({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
  const listed = await request({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const names = listed.result?.tools?.map((tool) => tool.name) ?? [];
  for (const name of dsmm.DSMM_LSP_TOOL_NAMES) {
    if (!names.includes(name)) throw new Error(`ocmm-lsp tools/list missing ${name}`);
  }

  const diagnostics = await request({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "diagnostics", arguments: { filePath: fixture.subject, severity: "all" } }
  });
  if (diagnostics.result?.isError !== false) throw new Error(`ocmm-lsp diagnostics failed: ${JSON.stringify(diagnostics)}`);
  const diagnosticText = diagnostics.result.content?.[0]?.text ?? "";
  if (!diagnosticText.includes("dsmm smoke diagnostic")) {
    throw new Error(`ocmm-lsp diagnostics response missing smoke diagnostic: ${diagnosticText}`);
  }

  const format = await request({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "format", arguments: { filePath: fixture.subject } }
  });
  if (format.result?.isError !== false) throw new Error(`ocmm-lsp format failed: ${JSON.stringify(format)}`);
  if (!format.result.content?.[0]?.text?.includes("Formatting committed atomically.")) {
    throw new Error(`ocmm-lsp format response did not confirm committed edit: ${JSON.stringify(format)}`);
  }
  if (readFileSync(fixture.subject, "utf8") !== 'const value: number = "wrong";\n') {
    throw new Error("ocmm-lsp format did not update the diagnostic fixture");
  }
} finally {
  await stopChild(child);
  fixture.cleanup();
}

console.log(`ocmm-lsp MCP smoke passed with ${command.join(" ")}`);

function request(message) {
  return new Promise((resolveRequest, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`timed out waiting for MCP response to ${message.method}; stderr: ${Buffer.concat(stderr).toString("utf8")}`));
    }, 15000);

    reader.next().then((line) => {
      clearTimeout(timeout);
      try {
        resolveRequest(JSON.parse(line));
      } catch (error) {
        reject(error);
      }
    }, (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.stdin.write(`${JSON.stringify(message)}\n`);
  });
}

function stopChild(target) {
  return new Promise((resolveStop) => {
    if (target.exitCode !== null || target.signalCode !== null) {
      resolveStop();
      return;
    }
    const timeout = setTimeout(resolveStop, 2000);
    target.once("close", () => {
      clearTimeout(timeout);
      resolveStop();
    });
    target.kill();
  });
}

function createLineReader(stream) {
  let buffer = "";
  const lines = [];
  const waiters = [];
  let ended = false;

  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    drain();
  });
  stream.on("end", () => {
    ended = true;
    while (waiters.length > 0) waiters.shift().reject(new Error("MCP stdout closed"));
  });
  stream.on("error", (error) => {
    while (waiters.length > 0) waiters.shift().reject(error);
  });

  return { next };

  function next() {
    if (lines.length > 0) return Promise.resolve(lines.shift());
    if (ended) return Promise.reject(new Error("MCP stdout closed"));
    return new Promise((resolveNext, reject) => waiters.push({ resolve: resolveNext, reject }));
  }

  function drain() {
    while (true) {
      const newline = buffer.search(/\r?\n/u);
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(buffer[newline] === "\r" ? newline + 2 : newline + 1);
      if (line === "") continue;
      if (waiters.length > 0) waiters.shift().resolve(line);
      else lines.push(line);
    }
  }
}
