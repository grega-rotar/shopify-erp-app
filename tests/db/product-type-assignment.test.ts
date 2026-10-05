import { afterEach, expect, it } from "vitest";

import {
  assignType,
  assignedTypeFor,
  clearAssignedType,
} from "~/adapters/db/repositories/product-type-assignment.server";

import {
  createTenant,
  describeDatabase,
  destroyTenant,
  type TestTenant,
} from "./harness";

/**
 * The product type a person chose for a product (docs/attributes.md § On
 * the product page): one per shop and product, replaced by choosing again,
 * gone when cleared, and never visible to another shop.
 */
describeDatabase("product type assignment", () => {
  const tenants: TestTenant[] = [];

  afterEach(async () => {
    for (const tenant of tenants.splice(0)) await destroyTenant(tenant);
  });

  it("keeps one choice per product, replaced and cleared", async () => {
    const tenant = await createTenant("type-choice");
    tenants.push(tenant);
    const product = "gid://shopify/Product/1";

    expect(await assignedTypeFor(tenant.principal, product)).toBeNull();
    await assignType(tenant.principal, product, "t-boards", "staff:1");
    await assignType(tenant.principal, product, "t-foils", "staff:1");
    expect(await assignedTypeFor(tenant.principal, product)).toBe("t-foils");

    await clearAssignedType(tenant.principal, product);
    expect(await assignedTypeFor(tenant.principal, product)).toBeNull();
  });

  it("keeps each shop's choices to itself", async () => {
    const one = await createTenant("type-choice-a");
    const two = await createTenant("type-choice-b");
    tenants.push(one, two);
    const product = "gid://shopify/Product/1";

    await assignType(one.principal, product, "t-boards", null);
    expect(await assignedTypeFor(two.principal, product)).toBeNull();
    await clearAssignedType(two.principal, product);
    expect(await assignedTypeFor(one.principal, product)).toBe("t-boards");
  });
});
