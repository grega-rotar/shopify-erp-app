import { describe, expect, it } from "vitest";

import {
  menuTree,
  menuTypeIds,
  typeFieldChanges,
  typePath,
  type MenuNode,
} from "~/domain/attributes/menu";
import { starterSchema } from "~/domain/attributes/starter";
import { emptySchema, type AttributeSchema } from "~/domain/attributes/types";

/**
 * docs/attributes.md § Store menu: a product carries its type and every
 * type above it; a type's collection matches its own id; the menu is the
 * tree, three levels deep.
 */

const titles = (nodes: readonly MenuNode[]): unknown =>
  nodes.map((node) =>
    node.children.length > 0
      ? { [node.title]: titles(node.children) }
      : node.title,
  );

function chain(depth: number): AttributeSchema {
  const schema = emptySchema();
  for (let level = 1; level <= depth; level++)
    schema.types.push({
      id: `l${level}`,
      name: `Level ${level}`,
      parentId: level === 1 ? null : `l${level - 1}`,
      leaf: level === depth,
      sortOrder: 1000,
      shopifyCategory: "",
      archetype: "",
    });
  return schema;
}

describe("the store menu", () => {
  it("starts below a single root and keeps sibling order", () => {
    expect(titles(menuTree(starterSchema()))).toEqual([
      {
        Windsurf: [
          { Sails: ["Wave sails", "Freeride sails"] },
          { Boards: ["Wave boards"] },
        ],
      },
      { Clothing: ["Wetsuits"] },
    ]);
  });

  it("keeps a lone root that has nothing beneath it", () => {
    expect(titles(menuTree(chain(1)))).toEqual(["Level 1"]);
  });

  it("stops at three levels; deeper types live in their ancestor's collection", () => {
    const schema = chain(6);
    schema.types.push({ ...schema.types[0]!, id: "other", name: "Other" });
    const tree = menuTree(schema);
    expect(menuTypeIds(tree)).toEqual(["l1", "l2", "l3", "other"]);
    // A level-6 product carries l3, so it is in l3's collection.
    expect(typePath(schema, "l6")).toEqual([
      "l1",
      "l2",
      "l3",
      "l4",
      "l5",
      "l6",
    ]);
  });
});

/** What a product of the type holds, as the catalogue would read it back. */
const WAVE = ["all", "windsurf", "sails", "wave"];

describe("each product's type field", () => {
  const product = (
    productId: string,
    fields: { productType?: string; current?: string[] },
  ) => ({
    productId,
    productType: fields.productType ?? null,
    categoryName: null,
    current: fields.current ?? null,
  });

  it("holds the type and every type above it, so one value fills a parent", () => {
    expect(typePath(starterSchema(), "wave")).toEqual(WAVE);
  });

  it("writes what changed, clears what lost its type and skips the rest", () => {
    const changes = typeFieldChanges(
      starterSchema(),
      [
        product("p1", { productType: "Wave sails" }),
        product("p2", { productType: "Wave sails", current: WAVE }),
        product("p3", { productType: "Kites", current: WAVE }),
        product("p4", {}),
        product("p5", { productType: "Wave sails" }),
        product("p6", {
          productType: "Wave sails",
          current: ["all", "sails", "wave"],
        }),
      ],
      new Map([["p5", "wetsuits"]]),
    );
    expect(changes).toEqual([
      { productId: "p1", kind: "set", path: WAVE },
      { productId: "p3", kind: "clear" },
      {
        productId: "p5",
        kind: "set",
        path: ["all", "clothing", "wetsuits"],
      },
      // The type moved in the tree since: its path is rewritten.
      { productId: "p6", kind: "set", path: WAVE },
    ]);
  });

  it("leaves a product two types claim as it is", () => {
    const schema = starterSchema();
    schema.types.push({
      ...schema.types.find((t) => t.id === "wave")!,
      id: "wave2",
      parentId: "boards",
    });
    expect(
      typeFieldChanges(
        schema,
        [product("p1", { productType: "Wave sails", current: WAVE })],
        new Map(),
      ),
    ).toEqual([]);
  });
});
