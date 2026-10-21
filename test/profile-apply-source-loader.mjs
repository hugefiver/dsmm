import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";
import "./prompt-source-loader.mjs";

const compiled = new URL("../lib/", import.meta.url).href;
const source = new URL("../src/", import.meta.url).href;

// Native fixtures and direct imports share one current-source module graph.
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL !== undefined && specifier.startsWith(".")) {
      const url = new URL(specifier, context.parentURL).href;
      const input = url.startsWith(compiled) ? `${source}${url.slice(compiled.length)}` : url;
      if (input.startsWith(source) && input.endsWith(".js")) {
        for (const extension of [".ts", ".tsx"]) {
          const candidate = `${input.slice(0, -3)}${extension}`;
          if (existsSync(fileURLToPath(candidate))) return next(candidate, context);
        }
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (!url.startsWith(source) || !url.endsWith(".tsx")) return next(url, context);
    const output = transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
      fileName: fileURLToPath(url), compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022,
        verbatimModuleSyntax: true, jsx: JsxEmit.ReactJSX },
    });
    return { format: "module", source: output.outputText, shortCircuit: true };
  },
});
