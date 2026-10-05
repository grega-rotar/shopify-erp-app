import { describe, expect, it } from "vitest";

import {
  productUpdateInput,
  variantInput,
} from "~/adapters/shopify/product-workspace";
import { emptySchema, type AttributeSchema } from "~/domain/attributes/types";
import {
  attributeCompleteness,
  cleanTags,
  displayMetafield,
  localeStatuses,
  moneyInput,
  parseMoney,
  productChanges,
  productIssues,
  staleFields,
  stockWriterFor,
  typeForProduct,
  validateProduct,
  variantChanges,
  type ProductFields,
} from "~/domain/products/workspace";
import { describeProductTrail, productPath } from "~/web/lib/product-workspace";

/**
 * The product workspace's rules (docs/architecture.md § Product workspace).
 */

function plan(): AttributeSchema {
  const schema = emptySchema();
  schema.types = [
    {
      id: "t-windsurf",
      name: "Windsurf",
      parentId: null,
      leaf: false,
      sortOrder: 0,
      shopifyCategory: "",
      archetype: "",
    },
    {
      id: "t-boards",
      name: "Boards",
      parentId: "t-windsurf",
      leaf: false,
      sortOrder: 0,
      shopifyCategory: "",
      archetype: "",
    },
    {
      id: "t-wave",
      name: "Wave",
      parentId: "t-boards",
      leaf: true,
      sortOrder: 0,
      shopifyCategory: "Windsurfing Boards",
      archetype: "",
    },
    {
      id: "t-slalom",
      name: "Slalom",
      parentId: "t-boards",
      leaf: true,
      sortOrder: 1,
      shopifyCategory: "",
      archetype: "",
    },
  ];
  schema.sets = [
    { id: "s-dim", name: "Dimensions", description: "" },
    { id: "s-build", name: "Construction", description: "" },
  ];
  const base = {
    unit: "",
    description: "",
    implementation: "custom" as const,
    filterable: false,
    searchable: false,
    comparable: false,
    valueListId: null,
  };
  schema.attributes = [
    {
      ...base,
      id: "a-volume",
      name: "Volume",
      setId: "s-dim",
      dataType: "integer",
      unit: "L",
      scope: "variant",
      key: "custom.volume",
      requiredDefault: true,
    },
    {
      ...base,
      id: "a-length",
      name: "Length",
      setId: "s-dim",
      dataType: "measurement",
      scope: "product",
      key: "custom.length",
      requiredDefault: true,
    },
    {
      ...base,
      id: "a-build",
      name: "Construction",
      setId: "s-build",
      dataType: "single_select",
      scope: "product",
      key: "custom.construction",
      requiredDefault: false,
      valueListId: "vl-build",
    },
    {
      ...base,
      id: "a-finbox",
      name: "Fin box",
      setId: "s-build",
      dataType: "text",
      scope: "product",
      key: "custom.fin_box",
      requiredDefault: true,
    },
    {
      ...base,
      id: "a-sail",
      name: "Sail range",
      setId: null,
      dataType: "text",
      scope: "product",
      key: "",
      requiredDefault: false,
    },
  ];
  // Sets attached high in the tree; the wave type inherits them.
  schema.setAssignments = [
    { id: "sa1", typeId: "t-boards", setId: "s-dim" },
    { id: "sa2", typeId: "t-windsurf", setId: "s-build" },
  ];
  schema.attributeAssignments = [
    { id: "aa1", typeId: "t-wave", attributeId: "a-sail" },
  ];
  // On wave boards the fin box is optional; on slalom it is hidden.
  schema.overrides = [
    {
      id: "o1",
      typeId: "t-wave",
      attributeId: "a-finbox",
      required: false,
      reason: "",
    },
  ];
  schema.exclusions = [
    { id: "x1", typeId: "t-slalom", attributeId: "a-finbox" },
  ];
  schema.valueLists = [
    { id: "vl-build", items: [{ code: "carbon", en: "Carbon", si: "Karbon" }] },
  ];
  return schema;
}

function fields(overrides: Partial<ProductFields> = {}): ProductFields {
  return {
    title: "Patrik F-Wave 95",
    descriptionHtml: "<p>Fast.</p>",
    vendor: "Patrik",
    productType: "Wave",
    status: "ACTIVE",
    tags: ["wave", "awaiting-review", "portal-source:src_1"],
    seoTitle: "",
    seoDescription: "",
    ...overrides,
  };
}

describe("which product type of the plan a product is", () => {
  it("matches the Shopify category first", () => {
    const match = typeForProduct(plan(), {
      categoryName: "Windsurfing Boards",
      categoryFullName: "Sporting Goods > Windsurfing Boards",
      productType: "Slalom",
    });
    expect(match).toMatchObject({
      kind: "matched",
      typeId: "t-wave",
      via: "category",
    });
    expect(match.kind === "matched" && match.path).toEqual([
      "Windsurf",
      "Boards",
      "Wave",
    ]);
  });

  it("falls back to the product type, by name or by path", () => {
    expect(
      typeForProduct(plan(), {
        categoryName: null,
        categoryFullName: null,
        productType: "slalom",
      }),
    ).toMatchObject({
      kind: "matched",
      typeId: "t-slalom",
      via: "product_type",
    });
    expect(
      typeForProduct(plan(), {
        categoryName: null,
        categoryFullName: null,
        productType: "Windsurf > Boards > Wave",
      }),
    ).toMatchObject({ kind: "matched", typeId: "t-wave" });
  });

  it("never matches an organising type, and says when nothing or more than one fits", () => {
    expect(
      typeForProduct(plan(), {
        categoryName: null,
        categoryFullName: null,
        productType: "Boards",
      }),
    ).toEqual({ kind: "none" });
    const twice = plan();
    twice.types.push({
      id: "t-wave2",
      name: "Wave",
      parentId: null,
      leaf: true,
      sortOrder: 2,
      shopifyCategory: "",
      archetype: "",
    });
    expect(
      typeForProduct(twice, {
        categoryName: null,
        categoryFullName: null,
        productType: "Wave",
      }),
    ).toMatchObject({ kind: "ambiguous", typeIds: ["t-wave", "t-wave2"] });
  });
});

describe("attribute completeness", () => {
  it("resolves inheritance, overrides and exclusions from the plan, grouped by set", () => {
    const result = attributeCompleteness(
      plan(),
      "t-wave",
      {
        "custom.length": {
          type: "dimension",
          value: '{"value":228,"unit":"CENTIMETERS"}',
        },
        "custom.construction": {
          type: "single_line_text_field",
          value: "carbon",
        },
      },
      [{ "custom.volume": { type: "number_integer", value: "95" } }, {}],
    );

    expect(result.groups.map((g) => g.name)).toEqual([
      "Dimensions",
      "Construction",
      "Other details",
    ]);
    // Volume is required and only one of two variants has it.
    expect(result.missingRequired).toEqual(["Volume"]);
    expect(result.requiredTotal).toBe(2);
    expect(result.requiredComplete).toBe(1);
    expect(result.unmapped).toBe(1);

    const rows = result.groups.flatMap((g) => g.rows);
    const row = (name: string) => rows.find((r) => r.name === name);
    expect(row("Length")?.value).toBe("228 centimeters");
    expect(row("Construction")?.value).toBe("Carbon");
    expect(row("Volume")).toMatchObject({
      value: "95 L",
      variantsWithValue: 1,
      state: "missing",
    });
    // Overridden to optional on wave boards.
    expect(row("Fin box")).toMatchObject({ required: false, state: "missing" });
    expect(row("Sail range")?.state).toBe("unmapped");
  });

  it("leaves an excluded attribute out", () => {
    const result = attributeCompleteness(plan(), "t-slalom", {}, []);
    const names = result.groups.flatMap((g) => g.rows.map((r) => r.name));
    expect(names).not.toContain("Fin box");
    expect(names).not.toContain("Sail range");
  });

  it("shows values the way a person reads them, never raw syntax", () => {
    expect(displayMetafield({ type: "boolean", value: "true" })).toBe("Yes");
    expect(
      displayMetafield({
        type: "product_reference",
        value: "gid://shopify/Product/1",
      }),
    ).toBe("Linked");
    expect(
      displayMetafield({
        type: "list.single_line_text_field",
        value: '["a","b"]',
      }),
    ).toBe("a, b");
    expect(
      displayMetafield({
        type: "list.product_reference",
        value: '["gid://x"]',
      }),
    ).toBe("1 linked");
    expect(
      displayMetafield({ type: "single_line_text_field", value: "  " }),
    ).toBeNull();
  });
});

describe("editing the product", () => {
  it("rejects what Shopify would, with a message next to the field", () => {
    const errors = validateProduct(
      fields({ title: "  ", tags: ["a,b"], seoDescription: "x".repeat(321) }),
    );
    expect(errors.title).toMatch(/Enter a title/);
    expect(errors.tags).toMatch(/comma/);
    expect(errors.seoDescription).toMatch(/320/);
    expect(validateProduct(fields())).toEqual({});
  });

  it("sends only what changed, and never removes the export portal's tags", () => {
    const saved = fields();
    const next = fields({
      title: " Patrik F-Wave 95 2026 ",
      tags: ["freestyle"],
    });
    const result = productChanges(saved, next);
    expect(result.change).toEqual({ title: "Patrik F-Wave 95 2026" });
    expect(result.add).toEqual(["freestyle"]);
    expect(result.remove).toEqual(["wave"]);
  });

  it("cleans typed tags", () => {
    expect(cleanTags([" a ", "", "A", "b"])).toEqual(["a", "b"]);
  });

  it("refuses to save over a field Shopify changed after the page read it", () => {
    const pageRead = fields();
    const live = fields({ title: "Renamed in Shopify" });
    expect(staleFields(pageRead, live, { title: "Mine" }, false)).toEqual([
      "title",
    ]);
    // A field this save does not touch may have moved; that is not a conflict.
    expect(staleFields(pageRead, live, { vendor: "X" }, false)).toEqual([]);
  });

  it("builds a productUpdate input from the changed fields only", () => {
    expect(
      productUpdateInput("gid://shopify/Product/1", { seoTitle: "T" }),
    ).toEqual({
      id: "gid://shopify/Product/1",
      seo: { title: "T" },
    });
  });
});

describe("editing variants", () => {
  const saved = [
    {
      variantId: "v1",
      priceMinor: 219900,
      compareAtMinor: 259900,
      sku: "25PFW95",
      barcode: null,
    },
    {
      variantId: "v2",
      priceMinor: 224900,
      compareAtMinor: null,
      sku: "25PFW105",
      barcode: null,
    },
  ];
  const input = (
    variantId: string,
    patch: Partial<Record<"price" | "compareAt" | "sku" | "barcode", string>>,
  ) => {
    const was = saved.find((v) => v.variantId === variantId);
    return {
      variantId,
      price: moneyInput(was?.priceMinor ?? 0),
      compareAt: moneyInput(was?.compareAtMinor ?? null),
      sku: was?.sku ?? "",
      barcode: was?.barcode ?? "",
      ...patch,
    };
  };

  it("reads money the way people type it", () => {
    expect(parseMoney("2199")).toBe(219900);
    expect(parseMoney("2199.5")).toBe(219950);
    expect(parseMoney("2.199,50")).toBe(219950);
    expect(parseMoney("1 199,00 €")).toBe(119900);
    expect(parseMoney("12.345")).toBeNull();
    expect(parseMoney("abc")).toBeNull();
    expect(moneyInput(219905)).toBe("2199.05");
  });

  it("refuses to change a price a live campaign holds", () => {
    const holds = new Map([
      [
        "v1",
        { campaignId: "c1", campaignName: "Summer Sale", state: "applied" },
      ],
    ]);
    const result = variantChanges(
      saved,
      [input("v1", { price: "1999.00" })],
      holds,
    );
    expect(result.changes).toEqual([]);
    expect(result.errors.v1?.price).toMatch(/Summer Sale manages this price/);
  });

  it("still lets the SKU and barcode of a held variant change", () => {
    const holds = new Map([
      [
        "v1",
        { campaignId: "c1", campaignName: "Summer Sale", state: "applied" },
      ],
    ]);
    const result = variantChanges(
      saved,
      [input("v1", { barcode: "3830000000001" })],
      holds,
    );
    expect(result.errors).toEqual({});
    expect(result.changes).toEqual([
      { variantId: "v1", barcode: "3830000000001" },
    ]);
  });

  it("wants a compare-at above the price, and accepts an empty one", () => {
    const bad = variantChanges(
      saved,
      [input("v2", { compareAt: "2000" })],
      new Map(),
    );
    expect(bad.errors.v2?.compareAt).toMatch(/higher than the price/);
    const cleared = variantChanges(
      saved,
      [input("v1", { compareAt: "" })],
      new Map(),
    );
    expect(cleared.changes).toEqual([
      { variantId: "v1", compareAtMinor: null },
    ]);
  });

  it("builds bulk input for only what changed on each variant", () => {
    expect(
      variantInput({ variantId: "v1", priceMinor: 199900, sku: "NEW" }),
    ).toEqual({
      id: "v1",
      price: "1999.00",
      inventoryItem: { sku: "NEW" },
    });
  });
});

describe("who writes a location's stock", () => {
  it("names one writer per location", () => {
    expect(
      stockWriterFor({ fulfillmentServiceName: "Partner 3PL" }, null),
    ).toEqual({
      kind: "fulfillment_service",
      service: "Partner 3PL",
    });
    expect(
      stockWriterFor(
        { fulfillmentServiceName: null },
        {
          stockDirection: "mk_to_shopify",
          enabled: true,
          warehouseName: "Glavno",
        },
      ),
    ).toEqual({ kind: "metakocka", warehouse: "Glavno", paused: false });
    expect(
      stockWriterFor(
        { fulfillmentServiceName: null },
        {
          stockDirection: "shopify_to_mk",
          enabled: false,
          warehouseName: null,
        },
      ),
    ).toEqual({ kind: "shopify", warehouse: null, paused: true });
    expect(stockWriterFor({ fulfillmentServiceName: null }, null)).toEqual({
      kind: "none",
    });
  });
});

describe("translation status per language", () => {
  const hash = (value: string) => `h:${value}`;
  const resource = {
    fields: [
      { key: "title", value: "Wave board", digest: "d1", type: "STRING" },
      { key: "body_html", value: "<p>Fast</p>", digest: "d2", type: "HTML" },
      { key: "handle", value: "wave-board", digest: "d3", type: "URI" },
    ],
  };

  it("counts like coverage, and keeps a person's and the AI's work apart", () => {
    const [de] = localeStatuses({
      fields: resource.fields,
      translations: new Map([
        [
          "de",
          [
            {
              key: "title",
              value: "Wellenbrett",
              outdated: false,
              updatedAt: null,
            },
            {
              key: "body_html",
              value: "<p>Schnell</p>",
              outdated: true,
              updatedAt: null,
            },
          ],
        ],
      ]),
      ownership: [
        { key: "title", locale: "de", owner: "ai", valueHash: "h:Wellenbrett" },
      ],
      locales: ["de"],
      kept: () => new Set(),
      hash,
    });
    expect(de).toMatchObject({ owed: 2, missing: 0, outdated: 1, percent: 50 });
    expect(de?.fields.map((f) => f.state)).toEqual(["ai", "outdated"]);
  });

  it("owes nothing for a field the language keeps in the original", () => {
    const [it_] = localeStatuses({
      fields: resource.fields,
      translations: new Map(),
      ownership: [],
      locales: ["it"],
      kept: () => new Set(["title"]),
      hash,
    });
    expect(it_).toMatchObject({ owed: 1, missing: 1 });
    expect(it_?.fields[0]).toEqual({ key: "title", state: "kept" });
  });
});

describe("what needs a person", () => {
  it("says nothing when nothing is wrong", () => {
    expect(
      productIssues({
        missingRequired: [],
        variantsWithoutSku: 0,
        unmatchedVariants: 0,
        locales: [{ name: "German", missing: 0, outdated: 0 }],
        saleDecisions: [],
        awaitingReview: false,
      }),
    ).toEqual([]);
  });

  it("names each problem once, with where it is fixed", () => {
    const issues = productIssues({
      missingRequired: ["Volume", "Length"],
      variantsWithoutSku: 0,
      unmatchedVariants: 1,
      locales: [{ name: "German", missing: 0, outdated: 1 }],
      saleDecisions: [
        { campaignId: "c1", campaignName: "Summer Sale", count: 2 },
      ],
      awaitingReview: true,
    });
    expect(issues.map((i) => i.text)).toEqual([
      "Waiting for review before it is published",
      "2 required details are missing",
      "1 variant has no MetaKocka product",
      "Summer Sale: 2 prices need a decision",
      "German: 1 outdated",
    ]);
    expect(issues[3]?.target).toEqual({ href: "/app/sales/c1/variants" });
    expect(issues[1]?.target).toEqual({ tab: "attributes" });
  });
});

describe("the product's activity", () => {
  const base = {
    languageName: (l: string) => (l === "de" ? "German" : l),
    variantTitle: () => "95 L",
    singleVariant: false,
  };

  it("never shows an event's own name, and leaves out what it cannot describe", () => {
    const items = describeProductTrail({
      ...base,
      trail: [
        {
          id: "1",
          at: "2026-09-28T16:42:00Z",
          entityType: "sale_variant",
          entityId: "v1",
          event: "sale_variant.price_changed",
          detail: {},
        },
        {
          id: "2",
          at: "2026-09-27T12:02:00Z",
          entityType: "translation",
          entityId: "p1",
          event: "translation.edited",
          detail: { locale: "de", written: 2, removed: 0 },
        },
        {
          id: "3",
          at: "2026-09-26T08:00:00Z",
          entityType: "product",
          entityId: "p1",
          event: "product.something_new",
          detail: {},
        },
        {
          id: "4",
          at: "2026-09-25T08:00:00Z",
          entityType: "product",
          entityId: "p1",
          event: "product.edited",
          detail: { fields: ["title", "descriptionHtml"] },
        },
      ],
      aiWork: [
        {
          id: "w",
          at: "2026-09-28T15:31:00Z",
          locale: "de",
          status: "translated",
          fields: 3,
        },
      ],
    });
    expect(items.map((i) => `${i.title}: ${i.text}`)).toEqual([
      "Sale: Sale price applied (95 L).",
      "German translation: 3 fields translated by AI.",
      "German translation: 2 fields edited by a person.",
      "Product: Changed the title and description here.",
    ]);
    for (const item of items)
      expect(`${item.title} ${item.text}`).not.toMatch(
        /[a-z]+_[a-z]+\.|\.[a-z]+_[a-z]+/,
      );
  });

  it("addresses a product by its number", () => {
    expect(productPath("gid://shopify/Product/42")).toBe("/app/products/42");
    expect(productPath("42", "variants")).toBe("/app/products/42?tab=variants");
  });
});
