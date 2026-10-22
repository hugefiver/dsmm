import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { integrationSuites, moduleSuites, smokeFiles } from "../test/suites.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const testDirectory = join(root, "test");
const testFiles = readdirSync(testDirectory)
  .filter(file => file.endsWith(".test.ts"))
  .sort();
const knownFiles = new Set(testFiles);
const integrationFiles = new Set(Object.values(integrationSuites).flat());

function fail(message) {
  console.error(message);
  process.exitCode = 2;
}

function validateConfiguration() {
  const configured = new Set([...smokeFiles, ...integrationFiles]);
  const missingFiles = [...configured].filter(file => !knownFiles.has(file));
  if (missingFiles.length > 0) {
    throw new Error(`Configured test files do not exist: ${missingFiles.join(", ")}`);
  }

  const quickFiles = testFiles.filter(file => !integrationFiles.has(file));
  const unclassified = quickFiles.filter(file =>
    !Object.values(moduleSuites).some(patterns => patterns.some(pattern => pattern.test(file)))
  );
  if (unclassified.length > 0) {
    throw new Error(`Quick test files have no module suite: ${unclassified.join(", ")}`);
  }
  for (const file of smokeFiles) {
    if (integrationFiles.has(file)) throw new Error(`Smoke test is also integration-only: ${file}`);
  }
}

function printHelp() {
  console.log(`DSMM test suites

Usage:
  pnpm run test:run
  pnpm run test:module -- <module> [module...]
  pnpm run test:integration -- <group> [group...]
  pnpm run test:diagnostic:all
  pnpm run test:list

Modules:
  ${Object.keys(moduleSuites).join("\n  ")}

Integration groups:
  ${Object.keys(integrationSuites).join("\n  ")}

All selected files run serially. Integration groups are never included by the
smoke or module entry points. diagnostic:all is an explicit non-default full run.`);
}

function selectNamed(names, suites, kind) {
  if (names.length === 0) {
    fail(`Select at least one ${kind}. Use pnpm run test:list for valid names.`);
    return [];
  }
  const unknown = names.filter(name => !Object.hasOwn(suites, name));
  if (unknown.length > 0) {
    fail(`Unknown ${kind}: ${unknown.join(", ")}. Use pnpm run test:list for valid names.`);
    return [];
  }
  if (kind === "module") {
    return testFiles.filter(file =>
      !integrationFiles.has(file) && names.some(name => suites[name].some(pattern => pattern.test(file)))
    );
  }
  return [...new Set(names.flatMap(name => suites[name]))].sort();
}

validateConfiguration();

const [mode, ...rawNames] = process.argv.slice(2);
const names = rawNames[0] === "--" ? rawNames.slice(1) : rawNames;
let selected = [];
if (mode === "--list") {
  if (names.length > 0) fail("--list does not accept suite names.");
  else printHelp();
} else if (mode === "--smoke") {
  if (names.length > 0) fail("--smoke does not accept suite names.");
  else selected = [...smokeFiles];
} else if (mode === "--module") {
  selected = selectNamed(names, moduleSuites, "module");
} else if (mode === "--integration") {
  selected = selectNamed(names, integrationSuites, "integration group");
} else if (mode === "--diagnostic-all") {
  if (names.length > 0) fail("--diagnostic-all does not accept suite names.");
  else selected = testFiles;
} else {
  fail("Choose --smoke, --module, --integration, --diagnostic-all, or --list.");
}

if (process.exitCode === undefined && selected.length > 0) {
  const result = spawnSync(process.execPath, [
    "--test",
    "--experimental-strip-types",
    "--import", "./test/prompt-source-loader.mjs",
    "--test-concurrency=1",
    ...selected.map(file => `test/${file}`),
  ], { cwd: root, stdio: "inherit" });
  if (result.error !== undefined) throw result.error;
  process.exitCode = result.status ?? 1;
}
