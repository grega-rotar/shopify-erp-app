import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import { FAKE_SERVICES_PORT } from "../support/env";
import { handleMetakocka } from "./metakocka";
import { handleShopifyGraphql } from "./shopify";
import { resetShop, shopState } from "./state";

/**
 * The fake services the e2e build talks to instead of Shopify and MetaKocka.
 *
 *   POST /shopify/graphql              Admin GraphQL, from the e2e Shopify module
 *   POST /metakocka/rest/eshop/v1/...  MetaKocka, rewritten by the network guard
 *
 * and the control API the specs use:
 *
 *   POST /__shops/:shop/reset          start a shop over with the given state
 *   GET  /__shops/:shop/calls          every call it received, and the unhandled ones
 *   GET  /__shops/:shop/state          the store and company as they are now
 *   GET  /__health
 *
 * State is in memory and per shop, so specs running in parallel on their own
 * shops do not see each other. An operation nobody wrote a handler for is
 * answered with an error *and* recorded, and every spec fails on an unhandled
 * call (tests/e2e/support/test.ts), so a page that starts asking Shopify
 * something new says so instead of silently showing an empty state.
 */

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? {} : JSON.parse(text);
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://fake");
  const path = url.pathname;

  if (path === "/__health") return send(response, 200, { ok: true });

  const control = /^\/__shops\/([^/]+)\/(reset|calls|state)$/.exec(path);
  if (control) {
    const shop = decodeURIComponent(control[1]!);
    if (control[2] === "reset" && request.method === "POST") {
      resetShop(shop, await readJson(request));
      return send(response, 200, { ok: true });
    }
    const state = shopState(shop);
    if (control[2] === "calls")
      return send(response, 200, state ? state.calls : null);
    if (control[2] === "state") {
      return send(
        response,
        200,
        state ? { shopify: state.shopify, metakocka: state.metakocka } : null,
      );
    }
  }

  if (path === "/shopify/graphql" && request.method === "POST") {
    return send(response, 200, handleShopifyGraphql(await readJson(request)));
  }

  const mk = /^\/metakocka\/rest\/eshop\/v1\/(.+)$/.exec(path);
  if (mk && request.method === "POST") {
    return send(
      response,
      200,
      handleMetakocka(mk[1]!, await readJson(request)),
    );
  }

  send(response, 404, {
    error: `fake services: no route for ${request.method} ${path}`,
  });
}

const server = createServer((request, response) => {
  route(request, response).catch((error: unknown) => {
    console.error("[fake-services]", error);
    send(response, 500, { error: String(error) });
  });
});

server.listen(FAKE_SERVICES_PORT, "127.0.0.1", () => {
  console.log(`[fake-services] listening on ${FAKE_SERVICES_PORT}`);
});
