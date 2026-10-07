import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { appEnv, E2E_BUILD_DIR, e2eDatabaseUrl } from "./env";

/**
 * The e2e stack, started by Playwright's `webServer` (playwright.config.ts):
 *
 *  1. brings the e2e database up to date with `prisma migrate deploy`, exactly
 *     as production applies migrations. Nothing is reset or dropped: every
 *     test works in a shop of its own and deletes it afterwards
 *     (tests/e2e/support/test.ts), so the database is empty between runs;
 *  2. starts the fake services, the worker and the web server from build-e2e/.
 *
 * Playwright waits for the web server's /healthz and stops the whole tree at
 * the end. If any of the three exits, so does the stack, and the run fails
 * instead of timing out.
 */

const require = createRequire(import.meta.url);

if (!existsSync(join(E2E_BUILD_DIR, "server", "index.js"))) {
  console.error(`[e2e] ${E2E_BUILD_DIR}/ is missing. Run: npm run build:e2e`);
  process.exit(1);
}

const env = { ...process.env, ...appEnv() };
const databaseUrl = e2eDatabaseUrl();

const migrate = spawnSync("npx prisma migrate deploy", {
  shell: true,
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: databaseUrl },
});
if (migrate.status !== 0) {
  console.error("[e2e] could not migrate the e2e database");
  process.exit(1);
}

const serveBin = join(
  dirname(require.resolve("@react-router/serve/package.json")),
  "bin.js",
);

const children: ChildProcess[] = [];

function start(name: string, args: string[]): void {
  const child = spawn(process.execPath, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const prefix = (chunk: Buffer) =>
    chunk
      .toString()
      .split(/\r?\n/)
      .filter((line) => line !== "")
      .map((line) => `[${name}] ${line}\n`)
      .join("");
  child.stdout?.on("data", (chunk: Buffer) =>
    process.stdout.write(prefix(chunk)),
  );
  child.stderr?.on("data", (chunk: Buffer) =>
    process.stderr.write(prefix(chunk)),
  );
  child.on("exit", (code) => {
    console.error(`[e2e] ${name} exited with ${code}`);
    stop(code ?? 1);
  });
  children.push(child);
}

function stop(code: number): never {
  for (const child of children) {
    child.removeAllListeners("exit");
    child.kill();
  }
  process.exit(code);
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

start("fake-services", [
  "--import",
  "tsx",
  "tests/e2e/fake-services/server.ts",
]);
start("worker", [join(E2E_BUILD_DIR, "worker", "worker.js")]);
start("web", [serveBin, join(E2E_BUILD_DIR, "server", "index.js")]);
