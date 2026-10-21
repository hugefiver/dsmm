import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { FRONTEND_PINS, frontendRecipe } from "./frontend-recipe.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const inventoryName = ".frontend-materialized.json";
export const gitBlob = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function destination(root, target, allowed) {
  if (!allowed.has(target)) throw new Error(`not a frontend-owned destination: ${target}`);
  const base = resolve(root, "skills/frontend"), path = resolve(base, target);
  if (!path.startsWith(`${base}${sep}`)) throw new Error(`frontend destination escapes owned root: ${target}`);
  for (let current = path; current !== dirname(resolve(root)); current = dirname(current)) {
    let stat;
    try { stat = lstatSync(current); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (stat.isSymbolicLink() || (current !== path && !stat.isDirectory()) || (current === path && !stat.isFile())) throw new Error(`frontend destination is linked or not a regular owned file: ${target}`);
  }
  return path;
}

function cachedInventory(root, recipe) {
  const path = destination(root, inventoryName, new Set([inventoryName]));
  if (!existsSync(path)) return undefined;
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!same(value.pins, FRONTEND_PINS) || !Array.isArray(value.files) || value.files.length !== recipe.length
    || !value.files.every((row, index) => same({ upstream: row.upstream, source: row.source, target: row.target, reason: row.reason }, recipe[index]) && /^[a-f0-9]{40}$/u.test(row.blob))) return undefined;
  return value;
}

export function checkFrontendAssets(root = packageRoot, recipe = frontendRecipe(root)) {
  const allowed = new Set(recipe.map((row) => row.target));
  const errors = [], inventory = cachedInventory(root, recipe);
  if (inventory === undefined) errors.push("missing/stale frontend provenance inventory; run explicit pnpm run sync:frontend (network), never an implicit build download");
  for (const row of recipe) {
    const path = destination(root, row.target, allowed);
    if (!existsSync(path)) { errors.push(`missing frontend resource: ${row.target} <- ${FRONTEND_PINS[row.upstream].repository}@${FRONTEND_PINS[row.upstream].commit}/${row.source}`); continue; }
  }
  if (inventory !== undefined && errors.length === 0) errors.push(...pythonResourceProblems(root));
  return { outcome: errors.length === 0 ? "ready" : "failed", errors, files: inventory?.files ?? [], pins: FRONTEND_PINS };
}

// Static dependency inspection, not an import/execution of third-party Python.
export function pythonResourceProblems(root = packageRoot) {
  const base = join(root, "skills/frontend/references/ui-ux-db"), errors = [];
  const standard = new Set(["argparse", "collections", "csv", "datetime", "io", "json", "math", "os", "pathlib", "re", "sys"]);
  for (const name of ["core", "design_system", "search"]) {
    const text = readFileSync(join(base, `scripts/${name}.py`), "utf8");
    for (const match of text.matchAll(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gmu)) {
      const module = (match[1] ?? match[2]).split(".")[0];
      if (!standard.has(module) && !existsSync(join(base, `scripts/${module}.py`))) errors.push(`unmapped Python import: ${name}.py -> ${module}`);
    }
    for (const match of text.matchAll(/["']((?:stacks\/)?[\w-]+\.csv)["']/gu)) {
      if (!existsSync(join(base, "data", match[1]))) errors.push(`unmapped Python data resource: ${name}.py -> ${match[1]}`);
    }
  }
  return [...new Set(errors)];
}

async function networkBytes(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000), headers: { "User-Agent": "dsmm-fixed-frontend-materializer", Accept: "application/vnd.github+json" } });
  if (!response.ok) throw new Error(`fixed frontend source unavailable: HTTP ${response.status} ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

export async function materializeFrontend({ root = packageRoot, fetchBytes = networkBytes } = {}) {
  if (resolve(root) !== packageRoot) {
    const marker = join(root, ".run-owner");
    if (dirname(resolve(root)) !== tmpdir() || !existsSync(marker) || lstatSync(marker).isSymbolicLink()
      || readFileSync(marker, "utf8") !== "frontend-materialization.test.ts\n") throw new Error("materialization outside DSMM requires a marked test-owned root; no arbitrary destination CLI is supported");
  }
  const recipe = frontendRecipe(root), allowed = new Set(recipe.map((row) => row.target));
  const before = checkFrontendAssets(root);
  if (before.outcome === "ready") return { outcome: "ready", requests: 0, differences: [], files: recipe.length };
  let requests = 0, inventory = cachedInventory(root, recipe);
  if (inventory === undefined) {
    const trees = new Map();
    for (const [name, pin] of Object.entries(FRONTEND_PINS)) {
      requests++;
      const tree = JSON.parse((await fetchBytes(`https://api.github.com/repos/${pin.repository}/git/trees/${pin.commit}?recursive=1`)).toString("utf8"));
      if (tree.truncated !== false || !Array.isArray(tree.tree)) throw new Error(`incomplete fixed frontend tree: ${pin.repository}@${pin.commit}`);
      trees.set(name, new Map(tree.tree.filter((entry) => entry.type === "blob").map((entry) => [entry.path, entry.sha])));
      if (trees.get(name).has("NOTICE") !== (pin.notice !== null)) throw new Error(`fixed NOTICE declaration drift: ${pin.repository}@${pin.commit}/NOTICE`);
    }
    inventory = { pins: FRONTEND_PINS, files: recipe.map((row) => {
      const blob = trees.get(row.upstream).get(row.source);
      if (blob === undefined) throw new Error(`fixed path missing: ${FRONTEND_PINS[row.upstream].repository}@${FRONTEND_PINS[row.upstream].commit}/${row.source} -> ${row.target}`);
      return { ...row, blob };
    }) };
  }
  const fetched = new Map(), changes = [];
  for (const row of inventory.files) {
    const path = destination(root, row.target, allowed);
    if (existsSync(path)) continue;
    const pin = FRONTEND_PINS[row.upstream], key = `${pin.repository}@${pin.commit}/${row.source}`;
    let bytes = fetched.get(key);
    if (bytes === undefined) { requests++; bytes = await fetchBytes(`https://raw.githubusercontent.com/${pin.repository}/${pin.commit}/${row.source}`); fetched.set(key, bytes); }
    if (gitBlob(bytes) !== row.blob || (row.source === "LICENSE" && row.blob !== pin.licenseBlob)) throw new Error(`fixed frontend content integrity mismatch: ${key}`);
    changes.push({ row, path, bytes });
  }
  // All immutable paths/content are validated before publishing any change.
  for (const { path, bytes, row } of changes) {
    destination(root, row.target, allowed);
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes);
  }
  const inventoryPath = destination(root, inventoryName, new Set([inventoryName]));
  const inventoryBytes = `${JSON.stringify(inventory, null, 2)}\n`;
  if (!existsSync(inventoryPath) || readFileSync(inventoryPath, "utf8") !== inventoryBytes) writeFileSync(inventoryPath, inventoryBytes);
  const result = checkFrontendAssets(root);
  if (result.outcome !== "ready") throw new Error(result.errors.join("\n"));
  return { outcome: "ready", requests, differences: changes.map(({ row }) => row.target), files: recipe.length };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length > 1 || (arguments_.length === 1 && !["--sync", "--check"].includes(arguments_[0]))) throw new Error("usage: materialize-frontend.mjs [--check | --sync]; only --sync authorizes network fetching");
  const result = arguments_[0] === "--sync" ? await materializeFrontend() : checkFrontendAssets();
  console.log(JSON.stringify({ ...result, files: Array.isArray(result.files) ? result.files.length : result.files }, null, 2));
  if (result.outcome !== "ready") process.exitCode = 1;
}
