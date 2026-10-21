import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

assert.ok(process.env.DSMM_TEST_DSH_ENTRY, "An explicit native installation anchor is required");
const native = createRequire(process.env.DSMM_TEST_DSH_ENTRY);
const adapter = pathToFileURL(native.resolve("@deepseek-ai/dsh-llm-pi-ai")).href;
const source = new URL("../src/", import.meta.url).href;
const lib = new URL("../lib/", import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@dsmm/dsmm/llm-runtime") {
      const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
      const target = manifest.exports["./llm-runtime"].default;
      return { url: new URL(target.replace("./lib/", "../src/").replace(/\.js$/u, ".ts"), import.meta.url).href, shortCircuit: true };
    }
    if ((specifier.startsWith(".") || specifier.startsWith("file:")) && context.parentURL !== undefined) {
      let candidate = new URL(specifier, context.parentURL).href;
      if (candidate.startsWith(lib)) candidate = source + candidate.slice(lib.length);
      if (candidate.startsWith(source) && candidate.endsWith(".js")) for (const extension of [".ts", ".tsx"]) {
        const input = candidate.slice(0, -3) + extension;
        if (existsSync(fileURLToPath(input))) return { url: input, shortCircuit: true };
      }
    }
    if (specifier.startsWith("@deepseek-ai/") && (context.parentURL?.startsWith(source) || context.parentURL?.includes("/dsmm/test/"))) {
      return { url: pathToFileURL(native.resolve(specifier)).href, shortCircuit: true };
    }
    if (specifier.startsWith("@earendil-works/pi-ai")) return next(specifier, { ...context, parentURL: adapter });
    const resolved = next(specifier, context);
    let url = resolved.url;
    if (url.startsWith(lib)) url = source + url.slice(lib.length);
    if (url.startsWith(source) && url.endsWith(".js") && existsSync(fileURLToPath(url.slice(0, -3) + ".ts"))) return { url: url.slice(0, -3) + ".ts", shortCircuit: true };
    return resolved;
  },
  load(url, context, next) {
    if (!url.startsWith(source) || !/\.tsx?$/u.test(url)) return next(url, context);
    return { format: "module", shortCircuit: true, source: transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
      fileName: fileURLToPath(url), compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022, jsx: JsxEmit.ReactJSX, verbatimModuleSyntax: true },
    }).outputText };
  },
});
