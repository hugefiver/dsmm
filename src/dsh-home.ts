import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// filesystem declares this public peer; incidental preset-registry resolution is not a contract.
const sdk = createRequire(require.resolve("@deepseek-ai/dsh-skill-filesystem"));
const home = sdk("@deepseek-ai/dsh-home-paths") as { resolveDshHome?: (configured?: string, env?: NodeJS.ProcessEnv) => string };
if (typeof home.resolveDshHome !== "function") throw new Error("Deepwork requires the public rc.2 DSH home resolver");

/** Trusted host/fixture input only, never a model or RPC root argument. */
export const resolveDshHome = home.resolveDshHome;
