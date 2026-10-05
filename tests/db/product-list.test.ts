import { afterEach, expect, it } from "vitest";

import { prisma } from "~/adapters/db/client.server";
import {
  catalogueFacetOptions,
  listCatalogueProducts,
  type ProductListQuery,
} from "~/adapters/db/repositories/product-workspace.server";
import { parseProductFilters } from "~/domain/products/product-list";

import {
  createTenant,
  describeDatabase,
  destroyTenant,
  type TestTenant,
} from "./harness";

/**
 * The product list over the catalogue snapshot (docs/architecture.md
 * § Product list): facet filters, hide archived, sort with empty values
 * last, and the values each facet offers — all within one shop.
 */
describeDatabase("product list", () => {
  const tenants: TestTenant[] = [];

  afterEach(async () => {
    for (const tenant of tenants.splice(0)) await destroyTenant(tenant);
  });

  async function seed(tenant: TestTenant) {
    const products = [
      {
        id: "1",
        title: "Board",
        vendor: "Aeryn",
        productType: "Boards",
        status: "ACTIVE",
        tags: ["kite", "sale"],
        updated: "2026-01-03",
      },
      {
        id: "2",
        title: "Foil",
        vendor: "Crosskites",
        productType: "Foils",
        status: "ARCHIVED",
        tags: ["wing"],
        updated: "2026-01-01",
      },
      {
        id: "3",
        title: "Harness",
        vendor: null,
        productType: null,
        status: "DRAFT",
        tags: [],
        updated: "2026-01-02",
      },
    ];
    for (const p of products) {
      await prisma.catalogProduct.create({
        data: {
          shopId: tenant.shopId,
          shopifyProductId: `gid://shopify/Product/${p.id}`,
          title: p.title,
          vendor: p.vendor,
          productType: p.productType,
          status: p.status,
          tags: p.tags,
          shopifyUpdatedAt: new Date(p.updated),
        },
      });
    }
  }

  const query = (patch: Partial<ProductListQuery>): ProductListQuery => ({
    q: "",
    status: "all",
    hideArchived: false,
    filters: parseProductFilters(() => []),
    sort: { key: "title", direction: "asc" },
    page: 1,
    pageSize: 50,
    ...patch,
  });

  it("filters by facets and hides archived", async () => {
    const tenant = await createTenant("product-list-filter");
    tenants.push(tenant);
    await seed(tenant);
    const titles = async (patch: Partial<ProductListQuery>) =>
      (await listCatalogueProducts(tenant.principal, query(patch))).rows.map(
        (row) => row.title,
      );

    expect(
      await titles({
        filters: { ...query({}).filters, vendor: ["Aeryn", "Crosskites"] },
      }),
    ).toEqual(["Board", "Foil"]);
    expect(
      await titles({ filters: { ...query({}).filters, tag: ["wing", "x"] } }),
    ).toEqual(["Foil"]);
    expect(await titles({ hideArchived: true })).toEqual(["Board", "Harness"]);
    expect(await titles({ status: "archived", hideArchived: true })).toEqual([
      "Foil",
    ]);
  });

  it("sorts with empty values last in either direction", async () => {
    const tenant = await createTenant("product-list-sort");
    tenants.push(tenant);
    await seed(tenant);
    const titles = async (patch: Partial<ProductListQuery>) =>
      (await listCatalogueProducts(tenant.principal, query(patch))).rows.map(
        (row) => row.title,
      );

    expect(
      await titles({ sort: { key: "vendor", direction: "desc" } }),
    ).toEqual(["Foil", "Board", "Harness"]);
    expect(
      await titles({ sort: { key: "updated", direction: "desc" } }),
    ).toEqual(["Board", "Harness", "Foil"]);
  });

  it("offers each facet's values from this shop only", async () => {
    const one = await createTenant("product-list-facets-a");
    const two = await createTenant("product-list-facets-b");
    tenants.push(one, two);
    await seed(one);

    expect(await catalogueFacetOptions(one.principal)).toEqual({
      vendor: ["Aeryn", "Crosskites"],
      productType: ["Boards", "Foils"],
      category: [],
      tag: ["kite", "sale", "wing"],
    });
    expect((await catalogueFacetOptions(two.principal)).vendor).toEqual([]);
  });
});
