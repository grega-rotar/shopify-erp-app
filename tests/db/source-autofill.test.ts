import { afterEach, expect, it } from "vitest";

import {
  getSourceAutofill,
  listSourceAutofill,
  setSourceAutofill,
} from "~/adapters/db/repositories/source-autofill.server";

import {
  createTenant,
  describeDatabase,
  destroyTenant,
  type TestTenant,
} from "./harness";

/**
 * AI categorization per source (docs/sources.md § AI categorization per
 * source): off until switched on, one setting per shop and source, never
 * visible to another shop.
 */
describeDatabase("source autofill settings", () => {
  const tenants: TestTenant[] = [];

  afterEach(async () => {
    for (const tenant of tenants.splice(0)) await destroyTenant(tenant);
  });

  it("is off until switched on, and replaced by the next change", async () => {
    const tenant = await createTenant("source-autofill");
    const other = await createTenant("source-autofill-other");
    tenants.push(tenant, other);

    expect(await getSourceAutofill(tenant.principal, "sc_1")).toEqual({
      enabled: false,
      fillAttributes: true,
    });

    await setSourceAutofill(
      tenant.principal,
      "sc_1",
      { enabled: true, fillAttributes: false },
      "staff:1",
    );
    await setSourceAutofill(
      tenant.principal,
      "sc_1",
      { enabled: true, fillAttributes: true },
      "staff:2",
    );
    expect(await getSourceAutofill(tenant.principal, "sc_1")).toEqual({
      enabled: true,
      fillAttributes: true,
    });
    expect([...(await listSourceAutofill(tenant.principal)).keys()]).toEqual([
      "sc_1",
    ]);
    expect((await getSourceAutofill(other.principal, "sc_1")).enabled).toBe(
      false,
    );
  });
});
