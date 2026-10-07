import { readFileSync } from "node:fs";

import type { Config } from "@react-router/dev/config";

/**
 * Hosts whose form submissions the server accepts.
 *
 * React Router rejects an action whose `Origin` header differs from the
 * request URL's origin, scheme included (7.18.3). Behind nginx, TLS ends at
 * the proxy and `react-router-serve` does not trust `X-Forwarded-Proto`, so
 * the server sees `http://` while the browser sends `https://` — and every
 * action came back 400 "Bad Request". The app's own host is not a cross-site
 * origin, so it is listed here: the deployed URL from `shopify.app.toml`,
 * and the tunnel the Shopify CLI passes as `SHOPIFY_APP_URL` in development.
 */
function ownHosts(): string[] {
  const urls = [process.env.SHOPIFY_APP_URL];
  try {
    const toml = readFileSync("shopify.app.toml", "utf8");
    urls.push(/^application_url\s*=\s*"([^"]+)"/m.exec(toml)?.[1]);
  } catch {
    // No app config in this checkout; the environment is all there is.
  }
  const hosts = new Set<string>();
  for (const url of urls) {
    if (!url) continue;
    try {
      hosts.add(new URL(url).host);
    } catch {
      // Not a URL; nothing to allow.
    }
  }
  return [...hosts];
}

export default {
  // The layout in docs/BUILD_SPEC.md section 5 puts the web tier under src/web
  // rather than the template's top-level app/ directory.
  appDirectory: "src/web",
  ssr: true,
  // The e2e build (vite.config.ts) is kept apart from the production one.
  buildDirectory: process.env.E2E_BUILD === "1" ? "build-e2e" : "build",
  allowedActionOrigins: ownHosts(),
} satisfies Config;
