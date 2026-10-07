import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { build, type Plugin } from "esbuild";

import { E2E_BUILD_DIR } from "./env";

/**
 * `npm run build:e2e`: the web app and the worker, built like production but
 * with the e2e Shopify module in place of the real one, into build-e2e/.
 *
 * The web half is `react-router build` with E2E_BUILD=1, which vite.config.ts
 * and react-router.config.ts read. The worker half is the same esbuild call as
 * `npm run build:worker`, plus a plugin doing what the Vite alias does.
 */

const FAKE_SHOPIFY = resolve("tests/e2e/app/shopify.server.ts");

const web = spawnSync("npx react-router build", {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, E2E_BUILD: "1" },
});
if (web.status !== 0) process.exit(web.status ?? 1);

const fakeShopify: Plugin = {
  name: "e2e-fake-shopify",
  setup(pluginBuild) {
    pluginBuild.onResolve(
      { filter: /^~\/adapters\/shopify\/shopify\.server$/ },
      () => ({ path: FAKE_SHOPIFY }),
    );
  },
};

await build({
  entryPoints: ["src/jobs/worker.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  outfile: `${E2E_BUILD_DIR}/worker/worker.js`,
  plugins: [fakeShopify],
  logLevel: "info",
});
