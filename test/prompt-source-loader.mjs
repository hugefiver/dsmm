import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

const source = new URL("../src/", import.meta.url).href;
const library = new URL("../lib/", import.meta.url).href;

// Exercise current source through native SDK modules without emitting shared lib/.
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL !== undefined && specifier.startsWith(".")) {
      const resolved = new URL(specifier, context.parentURL).href;
      const url = resolved.startsWith(library) ? source + resolved.slice(library.length) : resolved;
      if (url.startsWith(source) && url.endsWith(".js")) {
        for (const extension of [".ts", ".tsx"]) {
          const input = `${url.slice(0, -3)}${extension}`;
          if (existsSync(fileURLToPath(input))) return { url: input, shortCircuit: true };
        }
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (!url.startsWith(source) || !/\.tsx?$/u.test(url)) return next(url, context);
    const output = transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
      fileName: fileURLToPath(url), compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022, verbatimModuleSyntax: true, jsx: JsxEmit.ReactJSX }
    });
    return { format: "module", source: output.outputText, shortCircuit: true };
  }
});
