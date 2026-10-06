import { afterEach, expect, it } from "vitest";

import { prisma } from "~/adapters/db/client.server";
import {
  getTypeMenu,
  startTypeMenu,
  updateTypeMenu,
} from "~/adapters/db/repositories/type-menu.server";

import {
  createTenant,
  describeDatabase,
  destroyTenant,
  type TestTenant,
} from "./harness";

/**
 * The store menu's row (docs/attributes.md § Store menu): one run at a time
 * per shop, what earlier runs made kept across runs, and a run that died
 * long ago no longer in the way.
 */
describeDatabase("store menu runs", () => {
  const tenants: TestTenant[] = [];

  afterEach(async () => {
    for (const tenant of tenants.splice(0)) await destroyTenant(tenant);
  });

  it("starts one run at a time and keeps what earlier runs made", async () => {
    const tenant = await createTenant("type-menu");
    tenants.push(tenant);

    const presses = await Promise.all([
      startTypeMenu(tenant.principal, "staff:1"),
      startTypeMenu(tenant.principal, "staff:2"),
    ]);
    expect(presses.filter((p) => p.started)).toHaveLength(1);

    await updateTypeMenu(tenant.principal, {
      status: "done",
      menuId: "gid://shopify/Menu/1",
      collections: {
        t1: { collectionId: "gid://shopify/Collection/1", sourceId: null },
      },
    });
    expect(await startTypeMenu(tenant.principal, null)).toEqual({
      started: true,
    });
    expect(await startTypeMenu(tenant.principal, null)).toEqual({
      started: false,
    });

    const state = await getTypeMenu(tenant.principal);
    expect(state).toMatchObject({
      status: "running",
      menuId: "gid://shopify/Menu/1",
      collections: { t1: { collectionId: "gid://shopify/Collection/1" } },
    });
  });

  it("closes a run that stopped writing progress, so no page waits for ever", async () => {
    const tenant = await createTenant("type-menu-dead");
    tenants.push(tenant);
    await startTypeMenu(tenant.principal, null);
    expect((await getTypeMenu(tenant.principal))?.status).toBe("running");
    await prisma.$executeRaw`UPDATE product_type_menu SET updated_at = now() - interval '20 minutes' WHERE shop_id = ${tenant.shopId}`;

    const state = await getTypeMenu(tenant.principal);
    expect(state?.status).toBe("failed");
    expect(state?.lastError).toMatch(/stopped without finishing/);
  });

  it("lets a new run past one that stopped moving", async () => {
    const tenant = await createTenant("type-menu-stale");
    tenants.push(tenant);
    await startTypeMenu(tenant.principal, null);
    await prisma.$executeRaw`UPDATE product_type_menu SET updated_at = now() - interval '2 hours' WHERE shop_id = ${tenant.shopId}`;

    expect(await startTypeMenu(tenant.principal, null)).toEqual({
      started: true,
    });
  });
});
