import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

assert.ok(process.env.DSMM_TEST_DSH_ENTRY, "An explicit native installation anchor is required");
const native = createRequire(process.env.DSMM_TEST_DSH_ENTRY);
const adapter = pathToFileURL(native.resolve("@deepseek-ai/dsh-llm-pi-ai")).href;
const lib = new URL("../lib/", import.meta.url).href;
const tests = new URL("./", import.meta.url).href;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@deepseek-ai/") && (context.parentURL?.startsWith(lib) || context.parentURL?.startsWith(tests))) {
      return { url: pathToFileURL(native.resolve(specifier)).href, shortCircuit: true };
    }
    if (specifier.startsWith("@earendil-works/pi-ai")) return next(specifier, { ...context, parentURL: adapter });
    return next(specifier, context);
  },
});
