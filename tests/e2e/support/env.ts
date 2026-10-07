import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Everything the end-to-end stack is configured with, in one place.
 *
 * The stack is the app built in e2e mode (`npm run build:e2e`), its worker,
 * and the fake services that stand in for Shopify and MetaKocka. None of it
 * reads `.env` for anything but the database host: the values below are the
 * whole configuration, so a run on a laptop and a run in CI see the same app.
 * See docs/development.md § End-to-end tests.
 */

export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 4310);
export const FAKE_SERVICES_PORT = Number(process.env.E2E_FAKE_PORT ?? 4311);

export const BASE_URL = `http://127.0.0.1:${WEB_PORT}`;
export const FAKE_SERVICES_URL = `http://127.0.0.1:${FAKE_SERVICES_PORT}`;

/** Where the e2e build goes, apart from the production `build/`. */
export const E2E_BUILD_DIR = "build-e2e";

/**
 * A fixed key, so the test process can encrypt seeded MetaKocka credentials
 * that the app then decrypts. It protects nothing: the e2e database holds only
 * what the tests put there.
 */
export const E2E_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

/** The cookie the e2e Shopify module reads to know which shop is signed in. */
export const SHOP_COOKIE = "e2e_shop";

/**
 * The e2e database: `E2E_DATABASE_URL`, or the database in `.env`'s
 * `DATABASE_URL` with `_e2e` appended to its name.
 *
 * The stack drops and recreates this database's schema on every run, so the
 * name must end in `_e2e` — a check that keeps a mistyped URL from wiping a
 * development database.
 */
export function e2eDatabaseUrl(): string {
  const explicit = process.env.E2E_DATABASE_URL;
  const url = new URL(explicit ?? deriveFromDotEnv());

  const name = url.pathname.replace(/^\//, "");
  if (!name.endsWith("_e2e")) {
    throw new Error(
      `The e2e database must be named *_e2e, because every run resets it; got "${name}".`,
    );
  }
  return url.toString();
}

function deriveFromDotEnv(): string {
  const fromEnv = process.env.DATABASE_URL ?? readDotEnvDatabaseUrl();
  if (!fromEnv) {
    throw new Error(
      "No database for e2e: set E2E_DATABASE_URL, or DATABASE_URL in .env.",
    );
  }
  const url = new URL(fromEnv);
  const name = url.pathname.replace(/^\//, "");
  url.pathname = `/${name.endsWith("_e2e") ? name : `${name}_e2e`}`;
  return url.toString();
}

function readDotEnvDatabaseUrl(): string | null {
  const file = resolve(process.cwd(), ".env");
  if (!existsSync(file)) return null;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^\s*DATABASE_URL\s*=\s*(.+?)\s*$/.exec(line);
    if (match) return match[1]!.replace(/^["']|["']$/g, "");
  }
  return null;
}

/**
 * The environment the web server and worker run with. Production mode, so
 * `getEnv()` does not read `.env` and nothing here can be overridden by it.
 * No OpenAI key and no export portal: those features show their "not
 * configured" states, and the network guard would refuse the calls anyway.
 */
export function appEnv() {
  return {
    NODE_ENV: "production",
    SHOPIFY_API_KEY: "e2e-api-key",
    SHOPIFY_API_SECRET: "e2e-api-secret",
    SHOPIFY_APP_URL: BASE_URL,
    SCOPES:
      "read_products,write_products,read_inventory,read_locations,read_orders",
    DATABASE_URL: e2eDatabaseUrl(),
    ENCRYPTION_KEY: E2E_ENCRYPTION_KEY,
    OPENAI_API_KEY: "",
    EXPORT_PORTAL_URL: "",
    SENTRY_DSN: "",
    LOG_LEVEL: process.env.E2E_LOG_LEVEL ?? "warn",
    PORT: String(WEB_PORT),
    E2E_FAKE_SERVICES_URL: FAKE_SERVICES_URL,
  } satisfies Record<string, string>;
}
