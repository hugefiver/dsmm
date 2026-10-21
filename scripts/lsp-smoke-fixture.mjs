import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fixturePath = fileURLToPath(import.meta.url);

export function createDiagnosticWorkspace(prefix = "dsmm-lsp-smoke-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const subject = join(root, "subject.ts");
  const trace = join(root, "trace.jsonl");
  const projectConfig = join(root, "ocmm-lsp.json");
  const missingUserConfig = join(root, "missing-user-ocmm-lsp.json");

  writeFileSync(subject, "const value: number = 'wrong';\n", "utf8");
  writeFileSync(trace, "", "utf8");
  writeFileSync(projectConfig, JSON.stringify({
    lsp: {
      "dsmm-smoke": {
        command: [process.execPath, fixturePath],
        extensions: [".ts"],
        priority: 10000,
        env: { DSMM_LSP_SMOKE_TRACE: trace }
      }
    }
  }, null, 2), "utf8");

  return {
    root,
    subject,
    projectConfig,
    missingUserConfig,
    env: {
      OCMM_LSP_PROJECT_CONFIG: projectConfig,
      OCMM_LSP_USER_CONFIG: missingUserConfig
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  };
}

if (process.argv[1] === fixturePath) runServer();

function runServer() {
  const tracePath = process.env.DSMM_LSP_SMOKE_TRACE;
  let buffer = Buffer.alloc(0);

  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    drain();
  });

  process.stdin.resume();

  function drain() {
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;

      const headers = buffer.subarray(0, headerEnd).toString("utf8");
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)/iu.exec(headers);
      if (!match) throw new Error("missing Content-Length header");

      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + Number(match[1]);
      if (buffer.length < bodyEnd) return;

      const message = JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString("utf8"));
      buffer = buffer.subarray(bodyEnd);
      handle(message);
    }
  }

  function send(payload) {
    const body = Buffer.from(JSON.stringify(payload));
    process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
    process.stdout.write(body);
  }

  function trace(message) {
    if (tracePath) writeFileSync(tracePath, `${JSON.stringify(message)}\n`, { flag: "a" });
  }

  function handle(message) {
    trace(message);
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: { capabilities: { textDocumentSync: 1, documentFormattingProvider: true } } });
      return;
    }
    if (message.method === "textDocument/didOpen") {
      const uri = message.params.textDocument.uri;
      send({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: {
          uri,
          diagnostics: [{
            range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
            severity: 1,
            source: "dsmm-smoke",
            message: "dsmm smoke diagnostic"
          }]
        }
      });
      return;
    }
    if (message.method === "textDocument/formatting") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: [{
          range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
          newText: 'const value: number = "wrong";\n'
        }]
      });
      return;
    }
    if (message.method === "shutdown") {
      send({ jsonrpc: "2.0", id: message.id, result: null });
      return;
    }
    if (message.method === "exit") process.exit(0);
  }
}
