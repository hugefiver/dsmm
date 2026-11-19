import { createInterface } from "node:readline";

const tool = process.argv[2];
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) continue;
  let result;
  if (method === "initialize") result = { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
  else if (method === "tools/list") result = { tools: tool ? [{ name: tool, inputSchema: { type: "object", properties: {} } }] : [] };
  else if (method === "tools/call" && params.name === tool) result = { content: [{ type: "text", text: `stdio:${tool}` }] };
  else throw new Error(`Unexpected MCP call: ${method}`);
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
