import { describe, expect, it } from "vitest";

import {
  DEFAULT_PRODUCT_COLUMNS,
  DEFAULT_PRODUCT_SORT,
  hasProductFilters,
  moveColumn,
  normalizeColumns,
  parseProductFilters,
  parseProductSort,
  type ProductFacet,
} from "~/domain/products/product-list";

describe("parseProductSort", () => {
  it("falls back to title A to Z for anything unknown", () => {
    expect(parseProductSort(null, null)).toEqual(DEFAULT_PRODUCT_SORT);
    expect(parseProductSort("price; drop", "asc")).toEqual(
      DEFAULT_PRODUCT_SORT,
    );
  });

  it("defaults dates newest first and words A to Z", () => {
    expect(parseProductSort("updated", null)).toEqual({
      key: "updated",
      direction: "desc",
    });
    expect(parseProductSort("vendor", "sideways")).toEqual({
      key: "vendor",
      direction: "asc",
    });
    expect(parseProductSort("vendor", "desc")).toEqual({
      key: "vendor",
      direction: "desc",
    });
  });
});

describe("parseProductFilters", () => {
  const from =
    (values: Partial<Record<ProductFacet, string[]>>) =>
    (facet: ProductFacet) =>
      values[facet] ?? [];

  it("trims, drops blanks and repeats", () => {
    const filters = parseProductFilters(
      from({ vendor: [" Aeryn ", "Aeryn", "", "Crosskites"] }),
    );
    expect(filters.vendor).toEqual(["Aeryn", "Crosskites"]);
    expect(filters.tag).toEqual([]);
    expect(hasProductFilters(filters)).toBe(true);
  });

  it("caps the values of one facet", () => {
    const many = Array.from({ length: 80 }, (_, i) => `v${i}`);
    expect(parseProductFilters(from({ tag: many })).tag).toHaveLength(50);
  });

  it("reports no filters when every facet is empty", () => {
    expect(hasProductFilters(parseProductFilters(from({})))).toBe(false);
  });
});

describe("normalizeColumns", () => {
  it("returns the default for anything that is not a list", () => {
    expect(normalizeColumns(null)).toEqual(DEFAULT_PRODUCT_COLUMNS);
    expect(normalizeColumns("status")).toEqual(DEFAULT_PRODUCT_COLUMNS);
  });

  it("keeps a stored order and visibility, dropping unknown and repeated keys", () => {
    const columns = normalizeColumns([
      { key: "vendor", visible: false },
      { key: "inventory", visible: true },
      { key: "vendor", visible: true },
      { key: "status" },
    ]);
    expect(columns.slice(0, 2)).toEqual([
      { key: "vendor", visible: false },
      { key: "status", visible: true },
    ]);
    expect(columns).toHaveLength(DEFAULT_PRODUCT_COLUMNS.length);
    expect(columns.find((c) => c.key === "updated")?.visible).toBe(false);
  });
});

describe("moveColumn", () => {
  it("moves a column and clamps the target", () => {
    const keys = (from: number, to: number) =>
      moveColumn(DEFAULT_PRODUCT_COLUMNS, from, to).map((c) => c.key);
    expect(keys(0, 2).slice(0, 3)).toEqual([
      "category",
      "productType",
      "status",
    ]);
    expect(keys(1, 99).at(-1)).toBe("category");
    expect(keys(99, 0)).toEqual(DEFAULT_PRODUCT_COLUMNS.map((c) => c.key));
  });
});
