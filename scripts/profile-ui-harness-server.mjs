import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, readdir, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { COMPOSITION_ID, bootstrapFacade, carrierBootstrap, compositionBundle, createBootGraph } from "./profile-ui-harness-browser.mjs";

const SESSION_PROVIDER_IDS = ["@deepseek-ai/dsh-api-remote-access", "@deepseek-ai/dsh-api-remotes", "@deepseek-ai/dsh-client-file-upload", "@deepseek-ai/dsh-api-session-controller", "@deepseek-ai/dsh-client-ui-session"];
export const NATIVE_IDS = ["@deepseek-ai/dsh-client-modules", "@deepseek-ai/dsh-client-connection", "@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-renderer", "@deepseek-ai/dsh-typert-registry", "@deepseek-ai/dsh-api-gateway", "@deepseek-ai/dsh-client-ui-tool", ...SESSION_PROVIDER_IDS];
const mime = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf" };

export async function resolveNativeClientBundle(nativeRequire, id) {
  const manifestPath = nativeRequire.resolve(`${id}/package.json`);
  const packageRoot = dirname(await realpath(manifestPath));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const declaration = manifest.exports?.["./client"];
  const target = typeof declaration === "string" ? declaration : declaration?.browser ?? declaration?.default;
  assert.ok(typeof target === "string" && target.startsWith("./"), `${id} has no browser client export`);
  const filename = await realpath(resolve(packageRoot, target));
  const subpath = relative(packageRoot, filename);
  assert.ok(subpath !== "" && !subpath.startsWith("..") && !isAbsolute(subpath), `${id} browser client export escaped its package`);
  return { filename, manifest };
}

/** Serve only run-owned test HTML and exact installed, unmodified artifacts. */
export async function startProfileUiServer({ nativeRequire, packageRoot, sha256, composition = compositionBundle(), libraries = [], renderIndex = html => html }) {
  const frontendManifest = nativeRequire.resolve("@deepseek-ai/dsh-web-frontend/package.json");
  const frontendRoot = await realpath(join(dirname(frontendManifest), "dist"));
  const assets = await readdir(join(frontendRoot, "assets"));
  const indexFiles = assets.filter((name) => /^index-.*\.js$/u.test(name));
  assert.equal(indexFiles.length, 1, "native frontend must have exactly one compiled application entry");
  const styles = assets.filter((name) => /^(?:index|vendor)-.*\.css$/u.test(name));
  const bundles = new Map();
  const themeSource = await readFile(nativeRequire.resolve("@deepseek-ai/dsh-client-ui-theme/client"), "utf8");
  const themeStyles = extractNativeThemeStyles(themeSource);
  bundles.set("/bundles/native-theme.css", Buffer.from(themeStyles));
  const rows = [];
  const nativeIds = [...new Set([...NATIVE_IDS, ...libraries])];
  for (const [index, id] of nativeIds.entries()) {
    const url = `/bundles/native-${index}.js`;
    const { filename, manifest } = await resolveNativeClientBundle(nativeRequire, id);
    bundles.set(url, await readFile(filename));
    // Scope owners activate unchanged; their installed native metadata owns
    // the full package dependency graph, not harness-invented service aliases.
    const declaration = SESSION_PROVIDER_IDS.includes(id) ? manifest.dsh.client : undefined;
    const inject = declaration?.inject ?? (id === "@deepseek-ai/dsh-api-gateway" ? ["@deepseek-ai/dsh-typert-registry", COMPOSITION_ID]
      : id === "@deepseek-ai/dsh-client-ui-tool" ? ["@deepseek-ai/dsh-api-gateway", COMPOSITION_ID] : []);
    for (const dependency of inject) assert.ok(NATIVE_IDS.includes(dependency) || dependency === COMPOSITION_ID, `${id} requires unprovided native client package ${dependency}`);
    rows.push({ id, url, inject, external: declaration?.external ?? [] });
  }
  bundles.set("/bundles/composition.js", Buffer.from(composition));
  rows.push({ id: COMPOSITION_ID, url: "/bundles/composition.js", inject: ["@deepseek-ai/dsh-client-ui-renderer"], external: ["@deepseek-ai/dsh-client-connection/client", "@deepseek-ai/dsh-client-locale/client"] });
  bundles.set("/bundles/dsmm.js", await readFile(join(packageRoot, "lib", "client.js")));
  rows.push({ id: "@dsmm/dsmm", url: "/bundles/dsmm.js", inject: [COMPOSITION_ID, "@deepseek-ai/dsh-api-gateway", "@deepseek-ai/dsh-client-ui-renderer"] });
  const graph = createBootGraph(rows, sha256);
  const escapeJson = (value) => JSON.stringify(value).replaceAll("<", "\\u003c");
  const html = renderIndex(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>DSMM native profile component acceptance</title><link rel="icon" href="/native/favicon.svg">${styles.map((name) => `<link rel="stylesheet" href="/native/assets/${name}">`).join("")}<link rel="stylesheet" href="/bundles/native-theme.css"><script>${bootstrapFacade(libraries)}${carrierBootstrap()}window.__DSH_BOOT__=${escapeJson(graph)};</script>${rows.map(({ url }) => `<script src="${url}"></script>`).join("")}</head><body><div id="root"></div><script type="module" src="/native/assets/${indexFiles[0]}"></script></body></html>`);
  const errors = [];
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405).end(); return; }
      if (url.pathname === "/") { response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }).end(request.method === "HEAD" ? undefined : html); return; }
      if (bundles.has(url.pathname)) { response.writeHead(200, { "content-type": mime[extname(url.pathname)], "cache-control": "no-store" }).end(request.method === "HEAD" ? undefined : bundles.get(url.pathname)); return; }
      if (url.pathname.startsWith("/native/")) {
        const target = await realpath(resolve(frontendRoot, decodeURIComponent(url.pathname.slice("/native/".length))));
        const subpath = relative(frontendRoot, target);
        assert.ok(subpath !== "" && !subpath.startsWith("..") && !isAbsolute(subpath), "static request escaped installed frontend");
        response.writeHead(200, { "content-type": mime[extname(target)] ?? "application/octet-stream", "cache-control": "no-store" }).end(request.method === "HEAD" ? undefined : await readFile(target));
        return;
      }
      // This server intentionally has no /api, login, token, or RPC endpoint.
      response.writeHead(404).end();
    })().catch((error) => { errors.push(error.message); if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { origin: `http://127.0.0.1:${address.port}`, errors, graph, nativeFrontend: frontendRoot,
    bundleProof: { nativeIds, dsmmClient: join(packageRoot, "lib", "client.js"), rewrittenProductionBundles: false },
    async close() { server.closeAllConnections(); await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())); } };
}

/** Parse published JSON string literals, never evaluate or rewrite vendor JS. */
export function extractNativeThemeStyles(source) {
  const list = /const STYLES = \[([\s\S]*?)\];/u.exec(source)?.[1];
  assert.ok(list, "native theme style inventory is unavailable");
  const values = new Map([...source.matchAll(/var (\w+_css_default) = ("(?:\\.|[^"\\])*");/gu)].map((match) => [match[1], JSON.parse(match[2])]));
  const names = [...list.matchAll(/\["([^"]+)", (\w+)\]/gu)];
  assert.ok(names.length >= 4, "native theme inventory is unexpectedly incomplete");
  return names.map((match) => { assert.ok(values.has(match[2]), `native style ${match[1]} is unavailable`); return values.get(match[2]); }).join("\n");
}
