import { describe, expect, it } from "vitest";

import {
  emptySchema,
  type Attribute,
  type AttributeSchema,
} from "~/domain/attributes/types";
import {
  assignableTypes,
  attributeChanges,
  attributeFields,
  definitionKey,
  inputKey,
  inputsFrom,
  metafieldValue,
  sameInput,
  type AttributeField,
  type FieldEdit,
} from "~/domain/products/attribute-values";
import { typeForProduct } from "~/domain/products/workspace";

/**
 * Entering a product's attribute values by hand (docs/attributes.md § On
 * the product page): the chosen type, the field each attribute becomes,
 * and what an entry is written to Shopify as.
 */

const base = {
  unit: "",
  description: "",
  implementation: "custom" as const,
  filterable: false,
  searchable: false,
  comparable: false,
  valueListId: null,
  setId: null,
  requiredDefault: false,
  scope: "product" as const,
};

function attribute(
  over: Partial<Attribute> & Pick<Attribute, "id" | "dataType" | "key">,
): Attribute {
  return { ...base, name: over.id, ...over };
}

function plan(): AttributeSchema {
  const schema = emptySchema();
  schema.types = [
    {
      id: "t-wing",
      name: "Wing",
      parentId: null,
      leaf: false,
      sortOrder: 0,
      shopifyCategory: "",
      archetype: "",
    },
    {
      id: "t-boards",
      name: "Boards",
      parentId: "t-wing",
      leaf: true,
      sortOrder: 1,
      shopifyCategory: "Surfboards",
      archetype: "",
    },
    {
      id: "t-foils",
      name: "Foils",
      parentId: "t-wing",
      leaf: true,
      sortOrder: 0,
      shopifyCategory: "",
      archetype: "",
    },
  ];
  schema.attributes = [
    attribute({
      id: "a-length",
      dataType: "measurement",
      unit: "cm",
      key: "custom.length",
      requiredDefault: true,
    }),
    attribute({ id: "a-volume", dataType: "decimal", key: "custom.volume" }),
    attribute({
      id: "a-build",
      dataType: "single_select",
      key: "custom.construction",
      valueListId: "vl-build",
    }),
    attribute({
      id: "a-use",
      dataType: "multi_select",
      key: "custom.use",
      valueListId: "vl-use",
    }),
    attribute({ id: "a-tags", dataType: "multi_select", key: "custom.tags" }),
    attribute({ id: "a-ref", dataType: "reference", key: "custom.fin" }),
    attribute({ id: "a-none", dataType: "text", key: "" }),
    attribute({
      id: "a-size",
      dataType: "text",
      key: "custom.size",
      scope: "variant",
    }),
    attribute({ id: "a-specs", dataType: "text", key: "custom.specs" }),
  ];
  schema.attributeAssignments = schema.attributes.map((a, index) => ({
    id: `aa${index}`,
    typeId: "t-boards",
    attributeId: a.id,
  }));
  schema.valueLists = [
    { id: "vl-build", items: [{ code: "carbon", en: "Carbon", si: "Karbon" }] },
    {
      id: "vl-use",
      items: [
        { code: "wing", en: "Wing", si: "Wing" },
        { code: "sup", en: "SUP", si: "SUP" },
      ],
    },
  ];
  return schema;
}

function fieldsOf(
  definitions: Record<string, string> = {},
  product: Record<string, { type: string; value: string }> = {},
) {
  return attributeFields(plan(), "t-boards", {
    definitions: new Map(Object.entries(definitions)),
    product,
    variants: [],
  });
}

function field(fields: AttributeField[], id: string): AttributeField {
  const found = fields.find((f) => f.attributeId === id);
  if (!found) throw new Error(`no field ${id}`);
  return found;
}

describe("choosing the type", () => {
  it("offers only the types products can use, in path order", () => {
    expect(assignableTypes(plan()).map((t) => t.path.join(" › "))).toEqual([
      "Wing › Boards",
      "Wing › Foils",
    ]);
  });

  it("puts a chosen type ahead of the category match", () => {
    const product = {
      categoryName: "Surfboards",
      categoryFullName: null,
      productType: null,
    };
    expect(typeForProduct(plan(), product)).toMatchObject({
      typeId: "t-boards",
      via: "category",
    });
    expect(
      typeForProduct(plan(), { ...product, chosenTypeId: "t-foils" }),
    ).toMatchObject({ typeId: "t-foils", via: "chosen" });
  });

  it("falls back to the match when the chosen type left the plan", () => {
    expect(
      typeForProduct(plan(), {
        categoryName: "Surfboards",
        categoryFullName: null,
        productType: null,
        chosenTypeId: "t-gone",
      }),
    ).toMatchObject({ typeId: "t-boards", via: "category" });
  });
});

describe("the field each attribute becomes", () => {
  it("writes each format as its Shopify type when nothing says otherwise", () => {
    const fields = fieldsOf();
    expect(field(fields, "a-length").edit).toMatchObject({
      kind: "measurement",
      shopifyType: "dimension",
      measurementUnit: "CENTIMETERS",
      unit: "cm",
    });
    expect(field(fields, "a-volume").edit).toMatchObject({
      kind: "decimal",
      shopifyType: "number_decimal",
    });
    expect(field(fields, "a-build").edit).toMatchObject({
      kind: "choice",
      shopifyType: "single_line_text_field",
      options: [{ code: "carbon", label: "Carbon" }],
    });
    expect(field(fields, "a-use").edit).toMatchObject({
      kind: "choices",
      shopifyType: "list.single_line_text_field",
    });
  });

  it("follows the shop's definition over a stored value and the format", () => {
    const fields = fieldsOf(
      { [definitionKey("product", "custom.volume")]: "number_integer" },
      { "custom.volume": { type: "number_decimal", value: "4.5" } },
    );
    expect(field(fields, "a-volume").edit).toMatchObject({
      kind: "integer",
    });
  });

  it("follows a stored value's type when the shop has no definition", () => {
    const fields = fieldsOf(
      {},
      {
        "custom.length": {
          type: "dimension",
          value: '{"value":2.1,"unit":"METERS"}',
        },
      },
    );
    expect(field(fields, "a-length").edit).toMatchObject({
      measurementUnit: "METERS",
      unit: "m",
    });
  });

  it("says why a field cannot be entered here", () => {
    const fields = fieldsOf({
      [definitionKey("product", "custom.specs")]: "json",
    });
    const reason = (id: string) => {
      const edit: FieldEdit = field(fields, id).edit;
      return edit.kind === "blocked" ? edit.reason : null;
    };
    expect(reason("a-ref")).toMatch(/chosen in Shopify/);
    expect(reason("a-none")).toMatch(/No Shopify field/);
    expect(reason("a-tags")).toMatch(/no options/);
    expect(reason("a-specs")).toMatch(/json/);
  });

  it("reads what each field holds as a form shows it", () => {
    const fields = fieldsOf();
    const inputs = inputsFrom(
      fields,
      {
        "custom.length": {
          type: "dimension",
          value: '{"value":210,"unit":"CENTIMETERS"}',
        },
        "custom.use": {
          type: "list.single_line_text_field",
          value: '["wing"]',
        },
      },
      [
        {
          variantId: "v1",
          metafields: {
            "custom.size": { type: "single_line_text_field", value: "S" },
          },
        },
        { variantId: "v2", metafields: {} },
      ],
    );
    expect(inputs["a-length"]).toBe("210");
    expect(inputs["a-use"]).toEqual(["wing"]);
    expect(inputs["a-volume"]).toBe("");
    expect(inputs[inputKey("a-size", "v1")]).toBe("S");
    expect(inputs[inputKey("a-size", "v2")]).toBe("");
    expect(inputs["a-ref"]).toBeUndefined();
  });
});

describe("what an entry is written as", () => {
  const edit = (
    kind: Exclude<FieldEdit["kind"], "blocked">,
    extra: Partial<Extract<FieldEdit, { shopifyType: string }>> = {},
  ): FieldEdit => ({
    kind,
    shopifyType: "x",
    unit: "",
    measurementUnit: null,
    options: [
      { code: "wing", label: "Wing" },
      { code: "sup", label: "SUP" },
    ],
    ...extra,
  });

  it("checks numbers, dates and choices", () => {
    expect(metafieldValue(edit("integer"), "4.5")).toEqual({
      ok: false,
      error: "Enter a whole number.",
    });
    expect(metafieldValue(edit("integer"), "007")).toEqual({
      ok: true,
      value: "7",
    });
    expect(metafieldValue(edit("decimal"), "4,5")).toEqual({
      ok: true,
      value: "4.5",
    });
    expect(metafieldValue(edit("date"), "2026-02-30")).toMatchObject({
      ok: false,
    });
    expect(metafieldValue(edit("date"), "2026-02-28")).toEqual({
      ok: true,
      value: "2026-02-28",
    });
    expect(metafieldValue(edit("choice"), "kite")).toMatchObject({
      ok: false,
    });
    expect(metafieldValue(edit("boolean"), "true")).toEqual({
      ok: true,
      value: "true",
    });
  });

  it("writes a measurement with its unit and a list as JSON", () => {
    expect(
      metafieldValue(
        edit("measurement", { measurementUnit: "CENTIMETERS" }),
        "210,5",
      ),
    ).toEqual({ ok: true, value: '{"value":210.5,"unit":"CENTIMETERS"}' });
    expect(metafieldValue(edit("choices"), ["sup", "wing", "sup"])).toEqual({
      ok: true,
      value: '["sup","wing"]',
    });
  });

  it("clears a value that was emptied", () => {
    expect(metafieldValue(edit("text"), "  ")).toEqual({
      ok: true,
      value: null,
    });
    expect(metafieldValue(edit("choices"), [])).toEqual({
      ok: true,
      value: null,
    });
  });
});

describe("a save of attribute values", () => {
  const owners = { productId: "p1", variantIds: ["v1", "v2"] };

  it("writes only what changed, to the product or each variant", () => {
    const fields = fieldsOf();
    const before = { "a-volume": "4", "a-build": "", "a-size@v1": "S" };
    const changes = attributeChanges(fields, owners, before, {
      "a-volume": "4",
      "a-build": "carbon",
      "a-size@v1": "M",
      "a-size@v2": "",
    });
    expect(changes.errors).toEqual({});
    expect(changes.clears).toEqual([]);
    expect(changes.changed.sort()).toEqual(["a-build", "a-size@v1"]);
    expect(changes.writes).toEqual([
      {
        ownerId: "p1",
        namespace: "custom",
        key: "construction",
        type: "single_line_text_field",
        value: "carbon",
      },
      {
        ownerId: "v1",
        namespace: "custom",
        key: "size",
        type: "single_line_text_field",
        value: "M",
      },
    ]);
  });

  it("clears an emptied value and reports an invalid one by its field", () => {
    const fields = fieldsOf();
    const changes = attributeChanges(
      fields,
      owners,
      { "a-volume": "4", "a-use": ["wing"] },
      { "a-volume": "four", "a-use": [] },
    );
    expect(changes.errors).toEqual({ "a-volume": "Enter a number." });
    expect(changes.clears).toEqual([
      { ownerId: "p1", namespace: "custom", key: "use" },
    ]);
  });

  it("ignores inputs for fields it cannot write", () => {
    const changes = attributeChanges(
      fieldsOf(),
      owners,
      {},
      {
        "a-ref": "gid://shopify/Metaobject/1",
        "a-none": "x",
      },
    );
    expect(changes).toEqual({
      writes: [],
      clears: [],
      changed: [],
      errors: {},
    });
  });

  it("treats the same codes in another order as unchanged", () => {
    expect(sameInput(["wing", "sup"], ["sup", "wing"])).toBe(true);
    expect(sameInput("", [])).toBe(true);
    expect(sameInput(" 4 ", "4")).toBe(true);
  });
});
