import { defineConfig, devices } from "@playwright/test";

import { appEnv, BASE_URL } from "./tests/e2e/support/env";

/**
 * End-to-end tests: the e2e build of the app in a real browser, against the
 * fake Shopify and MetaKocka in tests/e2e/fake-services.
 * See docs/development.md § End-to-end tests.
 *
 * The specs seed the e2e database through the app's own repositories, so the
 * test process gets the app's environment too — with a small connection pool,
 * because every Playwright worker is a process with its own, and together
 * they would otherwise exhaust PostgreSQL's connections. E2E_DATABASE_URL is
 * pinned to the plain URL so the stack's own processes keep their full pools.
 */
const app = appEnv();
const testDatabaseUrl = new URL(app.DATABASE_URL);
testDatabaseUrl.searchParams.set("connection_limit", "2");
Object.assign(process.env, app, {
  E2E_DATABASE_URL: app.DATABASE_URL,
  DATABASE_URL: testDatabaseUrl.toString(),
});

const ci = process.env.CI === "true";

export default defineConfig({
  testDir: "tests/e2e/specs",
  // Each test gets its own shop, so tests run in parallel safely.
  fullyParallel: true,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  workers: ci ? 2 : 4,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: ci
    ? [["list"], ["html", { open: "never" }], ["github"]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1280, height: 900 },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npx tsx tests/e2e/support/stack.ts",
    url: `${BASE_URL}/healthz`,
    reuseExistingServer: !ci && process.env.E2E_REUSE === "1",
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
