import { afterEach, expect, it } from "vitest";

import { prisma } from "~/adapters/db/client.server";
import {
  catalogueForMenu,
  getTypeMenu,
  recordTypeField,
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
 * long ago no longer in the way; and the catalogue's copy of the type
 * field kept in step with what a run wrote, so the next run writes only
 * what moved.
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

  it("records a written path and a cleared one, keeping other fields", async () => {
    const tenant = await createTenant("type-menu");
    tenants.push(tenant);
    const other = {
      "custom.brand": { type: "single_line_text_field", value: "Point-7" },
    };
    for (const id of ["gid://shopify/Product/1", "gid://shopify/Product/2"])
      await prisma.catalogProduct.create({
        data: {
          shopId: tenant.shopId,
          shopifyProductId: id,
          title: id,
          metafields: {
            ...other,
            "recharge.product_type_path": {
              type: "list.single_line_text_field",
              value: JSON.stringify(["all", "old"]),
            },
          },
        },
      });

    await recordTypeField(tenant.principal, [
      { productId: "gid://shopify/Product/1", path: ["all", "wave"] },
      { productId: "gid://shopify/Product/2", path: null },
    ]);

    const menu = await catalogueForMenu(tenant.principal);
    expect(menu.map((p) => [p.productId, p.current])).toEqual([
      ["gid://shopify/Product/1", ["all", "wave"]],
      ["gid://shopify/Product/2", null],
    ]);
    const kept = await prisma.catalogProduct.findMany({
      where: { shopId: tenant.shopId },
      select: { metafields: true },
    });
    for (const row of kept) expect(row.metafields).toMatchObject(other);
  });
});
