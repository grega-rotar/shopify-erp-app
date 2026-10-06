import { afterEach, expect, it } from "vitest";

import { prisma } from "~/adapters/db/client.server";
import {
  countReadyAutofills,
  decideAutofill,
  failAutofill,
  getAutofill,
  listAutofills,
  markAutofillRunning,
  queueAutofills,
  saveAutofillSuggestion,
} from "~/adapters/db/repositories/product-autofill.server";

import {
  createTenant,
  describeDatabase,
  destroyTenant,
  type TestTenant,
} from "./harness";

/**
 * AI autofill suggestions (docs/attributes.md § AI autofill): one row per
 * product, a product being worked on is not asked twice, a suggestion is
 * closed once, and nothing crosses shops.
 */
describeDatabase("product autofill", () => {
  const tenants: TestTenant[] = [];
  const P1 = "gid://shopify/Product/1";
  const P2 = "gid://shopify/Product/2";

  afterEach(async () => {
    for (const tenant of tenants.splice(0)) await destroyTenant(tenant);
  });

  const suggestion = {
    typeId: "wave",
    typeOrigin: "suggested" as const,
    typeConfidence: 0.9,
    typeReason: "By name.",
    values: [
      {
        key: "brand",
        attributeId: "brand",
        variantId: null,
        name: "Brand",
        input: "Point-7",
        display: "Point-7",
      },
    ],
    engine: "export-portal",
  };

  it("queues once, keeps the suggestion, and closes it once", async () => {
    const tenant = await createTenant("autofill");
    tenants.push(tenant);

    expect(await queueAutofills(tenant.principal, [P1, P2], "staff")).toEqual([
      P1,
      P2,
    ]);
    expect(await queueAutofills(tenant.principal, [P1], "staff")).toEqual([]);

    await saveAutofillSuggestion(tenant.principal, P1, suggestion);
    await failAutofill(tenant.principal, P2, "No answer.");
    expect(await countReadyAutofills(tenant.principal)).toBe(1);

    const state = await getAutofill(tenant.principal, P1);
    expect(state).toMatchObject({
      status: "ready",
      typeId: "wave",
      typeOrigin: "suggested",
      values: suggestion.values,
    });
    expect(
      (await listAutofills(tenant.principal, [P1, P2])).get(P2),
    ).toMatchObject({
      status: "failed",
      error: "No answer.",
    });

    expect(await decideAutofill(tenant.principal, P1, "applied", "staff")).toBe(
      true,
    );
    expect(
      await decideAutofill(tenant.principal, P1, "discarded", "staff"),
    ).toBe(false);
    expect((await getAutofill(tenant.principal, P1))?.status).toBe("applied");

    // Asking again replaces what was there.
    expect(await queueAutofills(tenant.principal, [P1], null)).toEqual([P1]);
    expect(await getAutofill(tenant.principal, P1)).toMatchObject({
      status: "queued",
      typeId: null,
      values: [],
    });
  });

  it("fails a product whose suggestion will never come", async () => {
    const tenant = await createTenant("autofill-dead");
    tenants.push(tenant);
    await queueAutofills(tenant.principal, [P1, P2], null);
    await markAutofillRunning(tenant.principal, P1);
    await prisma.$executeRaw`UPDATE product_autofill SET updated_at = now() - interval '40 minutes' WHERE shop_id = ${tenant.shopId}`;

    const states = await listAutofills(tenant.principal, [P1, P2]);
    expect(states.get(P1)).toMatchObject({ status: "failed" });
    expect(states.get(P1)?.error).toMatch(/Ask again/);
    // A product still waiting its turn is given longer.
    expect(states.get(P2)?.status).toBe("queued");
  });

  it("never shows one shop's suggestion to another", async () => {
    const one = await createTenant("autofill-one");
    const two = await createTenant("autofill-two");
    tenants.push(one, two);
    await saveAutofillSuggestion(one.principal, P1, suggestion);
    expect(await getAutofill(two.principal, P1)).toBeNull();
    expect(await decideAutofill(two.principal, P1, "applied", null)).toBe(
      false,
    );
  });
});
