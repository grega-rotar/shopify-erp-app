/**
 * Outbound HTTP for the e2e build: MetaKocka goes to the fake services, the
 * fake services and loopback pass, and everything else is refused.
 *
 * This is the e2e build's guarantee that a test never reaches a live
 * MetaKocka company, Shopify, OpenAI or the export portal (AGENTS.md § Project
 * constraints), whatever the code under test does. It is installed when the
 * e2e Shopify module is first evaluated, which is before any request or job
 * runs; `MetakockaClient` captures `fetch` when it is constructed, so it gets
 * this one.
 *
 * Bundled only into `build-e2e/` (see vite.config.ts); never into `build/`.
 */

const METAKOCKA_ORIGIN = "https://main.metakocka.si";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function fakeServicesUrl(): string {
  const url = process.env.E2E_FAKE_SERVICES_URL;
  if (!url) {
    throw new Error(
      "This is the e2e build (build-e2e/), which only runs against the fake services: E2E_FAKE_SERVICES_URL is not set.",
    );
  }
  return url.replace(/\/+$/, "");
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

let installed = false;

export function installNetworkGuard(): void {
  if (installed) return;
  installed = true;

  const fake = fakeServicesUrl();
  const realFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async (input, init) => {
    const url = urlOf(input);

    if (url.startsWith(`${METAKOCKA_ORIGIN}/`)) {
      const rewritten = `${fake}/metakocka${url.slice(METAKOCKA_ORIGIN.length)}`;
      return realFetch(
        input instanceof Request ? new Request(rewritten, input) : rewritten,
        init,
      );
    }

    if (LOOPBACK.has(new URL(url).hostname)) return realFetch(input, init);

    throw new Error(
      `e2e network guard: refused an outbound request to ${new URL(url).origin}. Fake it in tests/e2e/fake-services.`,
    );
  };
}
