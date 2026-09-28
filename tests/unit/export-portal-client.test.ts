import { describe, expect, it, vi } from "vitest";

import { ExportPortalClient } from "~/adapters/export-portal/client.server";
import {
  ExportPortalError,
  describeForMerchant,
} from "~/adapters/export-portal/errors";

/**
 * The portal client against a recorded portal (docs/sources.md § The
 * contract). Every reply is parsed; every refusal becomes one
 * `ExportPortalError` whose kind a screen can act on.
 */
const CREDENTIALS = {
  baseUrl: "https://export.example.test",
  apiKey: "rhk_live_0123456789abcdef",
  shopDomain: "recharge.myshopify.com",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function clientWith(fetchImpl: (...args: never[]) => Promise<Response>) {
  return new ExportPortalClient(CREDENTIALS, {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    timeoutMs: 200,
  });
}

function calledWith(
  fetchImpl: ReturnType<typeof vi.fn>,
): [string, RequestInit] {
  return fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
}

async function failure(promise: Promise<unknown>): Promise<ExportPortalError> {
  const error = await promise.then(
    () => new Error("expected the call to fail"),
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ExportPortalError);
  return error as ExportPortalError;
}

const SOURCE = {
  id: "src_1",
  name: "Partner feed",
  kind: "product_feed",
  kindLabel: "Product feed",
  enabled: true,
  destination: "SFTP partner-x",
  schedule: {
    mode: "automatic",
    description: "Every day at 04:00",
    nextRunAt: "2026-09-23T02:00:00Z",
  },
  health: "ok",
  lastRun: null,
  fields: [
    { key: "path", label: "Folder", type: "text", required: true },
    { key: "password", label: "Password", type: "secret" },
  ],
  values: { path: "/out", password: "••••1234" },
};

describe("export portal client", () => {
  it("carries the key, the shop and the contract version on every call", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        tenant: { id: "t1", name: "Recharge" },
        shop: { domain: CREDENTIALS.shopDomain },
      }),
    );
    const connection = await clientWith(fetchImpl).connection();

    expect(connection.tenant.name).toBe("Recharge");
    const [url, init] = calledWith(fetchImpl);
    expect(url).toBe("https://export.example.test/api/v1/connection");
    expect(init.method).toBe("GET");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${CREDENTIALS.apiKey}`);
    expect(headers["x-shop-domain"]).toBe(CREDENTIALS.shopDomain);
    expect(init.body).toBeUndefined();
  });

  it("parses a source and posts a partial write as JSON", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ source: SOURCE }));
    const source = await clientWith(fetchImpl).updateSource("src 1", {
      values: { path: "/in" },
    });

    expect(source.values.path).toBe("/out");
    expect(source.schedule.mode).toBe("automatic");
    const [url, init] = calledWith(fetchImpl);
    expect(url).toBe("https://export.example.test/api/v1/sources/src%201");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ values: { path: "/in" } });
  });

  it("treats a reply outside the contract as unreadable, not as data", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ sources: [{ id: "x", name: "No kind" }] }),
    );
    const error = await failure(clientWith(fetchImpl).listSources());
    expect(error.kind).toBe("unreadable");
  });

  it("accepts an empty body on delete", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(null, 204));
    await expect(
      clientWith(fetchImpl).deleteSource("src_1"),
    ).resolves.toBeUndefined();
    expect(calledWith(fetchImpl)[1].method).toBe("DELETE");
  });

  it("maps a 401 to unauthorized and a 403 to forbidden", async () => {
    const unauthorized = await failure(
      clientWith(
        vi.fn(async () => jsonResponse({ error: { message: "bad key" } }, 401)),
      ).listSources(),
    );
    expect(unauthorized.kind).toBe("unauthorized");
    expect(describeForMerchant(unauthorized)).toContain(
      "did not accept the API key",
    );

    const forbidden = await failure(
      clientWith(vi.fn(async () => jsonResponse(null, 403))).listSources(),
    );
    expect(forbidden.kind).toBe("forbidden");
    expect(describeForMerchant(forbidden)).toContain("different store");
  });

  it("carries per-field messages from a validation refusal", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          error: {
            code: "invalid",
            message: "Folder must exist on the server.",
          },
          errors: [
            { field: "path", message: "Folder must exist on the server." },
          ],
        },
        422,
      ),
    );
    const error = await failure(
      clientWith(fetchImpl).updateSource("src_1", {
        values: { path: "/nope" },
      }),
    );
    expect(error.kind).toBe("validation");
    expect(error.fieldErrors).toEqual([
      { field: "path", message: "Folder must exist on the server." },
    ]);
    // The portal's own words reach the merchant for a validation refusal.
    expect(describeForMerchant(error)).toBe("Folder must exist on the server.");
  });

  it("shows a 409 in the portal's own words: it names the state", async () => {
    const error = await failure(
      clientWith(
        vi.fn(async () =>
          jsonResponse(
            {
              error: {
                code: "run_in_progress",
                message:
                  "A run is already in progress for this store. Wait for it to finish.",
              },
            },
            409,
          ),
        ),
      ).startRun("src_1"),
    );
    expect(error.kind).toBe("conflict");
    expect(describeForMerchant(error)).toBe(
      "A run is already in progress for this store. Wait for it to finish.",
    );
  });

  it("shows a 409 in the portal's own words: it names the state", async () => {
    const error = await failure(
      clientWith(
        vi.fn(async () =>
          jsonResponse(
            {
              error: {
                code: "run_in_progress",
                message:
                  "A run is already in progress for this store. Wait for it to finish.",
              },
            },
            409,
          ),
        ),
      ).startRun("src_1"),
    );
    expect(error.kind).toBe("conflict");
    expect(describeForMerchant(error)).toBe(
      "A run is already in progress for this store. Wait for it to finish.",
    );
  });

  it("reports a 5xx as the portal's problem and a network failure as unavailable", async () => {
    const server = await failure(
      clientWith(
        vi.fn(async () => new Response("<html>oops</html>", { status: 502 })),
      ).listSources(),
    );
    expect(server.kind).toBe("server");
    expect(server.httpStatus).toBe(502);

    const down = await failure(
      clientWith(
        vi.fn(async () => Promise.reject(new TypeError("fetch failed"))),
      ).listSources(),
    );
    expect(down.kind).toBe("unavailable");
  });

  it("gives up after the timeout", async () => {
    const fetchImpl = vi.fn(
      (_url: unknown, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    );
    const error = await failure(clientWith(fetchImpl).listSources());
    expect(error.kind).toBe("unavailable");
    expect(error.message).toContain("did not answer in time");
  });

  it("never puts the key in the error", async () => {
    const error = await failure(
      clientWith(vi.fn(async () => jsonResponse(null, 500))).listSources(),
    );
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain(
      CREDENTIALS.apiKey,
    );
  });
});
