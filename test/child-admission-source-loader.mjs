import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const project = createRequire(new URL("../package.json", import.meta.url));
const sdkAnchor = process.env.DSMM_TEST_DSH_ENTRY === undefined ? new URL("../package.json", import.meta.url).href
  : pathToFileURL(realpathSync(process.env.DSMM_TEST_DSH_ENTRY)).href;
const sdk = createRequire(sdkAnchor);
const ts = project("typescript");
const source = new URL("../src/", import.meta.url).href;
const compiled = new URL("../lib/", import.meta.url).href;
let resolvingPeer = false;

// Test-owned in-memory source compilation: no shared lib writes or SDK modifications.
registerHooks({
  resolve(specifier, context, next) {
    if (resolvingPeer) return next(specifier, context);
    if (specifier === "@dsmm/dsmm" || specifier === "@dsmm/dsmm/subagent-runtime" || specifier === "@dsmm/dsmm/agent-registry") {
      return { url: new URL(specifier === "@dsmm/dsmm" ? "index.ts" : specifier.endsWith("/agent-registry") ? "agent-registry.ts" : "runtime-integration.ts", source).href, shortCircuit: true };
    }
    if (specifier.startsWith("@deepseek-ai/") || specifier === "jsonc-parser") {
      resolvingPeer = true;
      try { return { url: pathToFileURL((specifier === "jsonc-parser" ? project : sdk).resolve(specifier)).href, shortCircuit: true }; }
      finally { resolvingPeer = false; }
    }
    if (context.parentURL !== undefined && specifier.startsWith(".")) {
      let url = new URL(specifier, context.parentURL);
      if (url.href.startsWith(compiled)) url = new URL(source + url.href.slice(compiled.length));
      if (url.href.startsWith(source) && url.pathname.endsWith(".js")) {
        url.pathname = url.pathname.slice(0, -3) + ".ts";
        if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith(source) && url.endsWith(".ts")) {
      return { format: "module", source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
        fileName: fileURLToPath(url), compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
          verbatimModuleSyntax: true, sourceMap: false },
      }).outputText, shortCircuit: true };
    }
    return next(url, context);
  },
});
