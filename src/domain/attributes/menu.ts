import { ancestry, childrenOf } from "~/domain/attributes/resolve";
import { KEY_NAMESPACE, type AttributeSchema } from "~/domain/attributes/types";
import { typeForProduct } from "~/domain/products/workspace";

/**
 * The store menu made from the product type tree (docs/attributes.md § Store
 * menu). Pure: what each product's type field should hold and the menu's
 * shape. The job turns it into Shopify.
 *
 * A product carries its type and every type above it in one list metafield,
 * the way a product would carry tags; a type's automated collection matches
 * one value, its own id. So a parent's collection lists everything beneath
 * it however large the branch, and every collection condition stays within
 * Shopify's limit of 60 values per source.
 */

/** The product field the collections match on: type ids, top level first. */
export const MENU_TYPE_FIELD = {
  namespace: KEY_NAMESPACE,
  key: "product_type_path",
  type: "list.single_line_text_field",
} as const;

/**
 * The single-value field the first version of the menu wrote (a type id),
 * whose collections listed every type beneath them and so outgrew Shopify's
 * condition limit. A run deletes its definition and values.
 */
export const LEGACY_MENU_TYPE_FIELD = {
  namespace: KEY_NAMESPACE,
  key: "product_type_id",
} as const;

/** The menu's name and handle in Shopify. */
export const TYPE_MENU_TITLE = "Product types";
export const TYPE_MENU_HANDLE = "product-types";

/** Shopify menus nest three levels; deeper types are inside their level-3 ancestor's collection. */
export const MENU_DEPTH = 3;

/** What a product of this type holds: the type and its ancestors, top level first. */
export function typePath(schema: AttributeSchema, typeId: string): string[] {
  return ancestry(schema, typeId).reverse();
}

export interface MenuNode {
  typeId: string;
  title: string;
  children: MenuNode[];
}

/**
 * The menu, top level first. A tree under one root (All products) starts at
 * the root's children, since a menu with a single entry is no menu.
 */
export function menuTree(schema: AttributeSchema): MenuNode[] {
  const build = (parentId: string | null, depth: number): MenuNode[] =>
    childrenOf(schema, parentId).map((type) => ({
      typeId: type.id,
      title: type.name,
      children: depth < MENU_DEPTH ? build(type.id, depth + 1) : [],
    }));
  const roots = childrenOf(schema, null);
  const [only] = roots;
  if (roots.length === 1 && only && childrenOf(schema, only.id).length > 0)
    return build(only.id, 1);
  return build(null, 1);
}

/** Every type a menu entry points at: the menu's types, folded ones excluded. */
export function menuTypeIds(nodes: readonly MenuNode[]): string[] {
  return nodes.flatMap((node) => [node.typeId, ...menuTypeIds(node.children)]);
}

export interface CatalogueProductForMenu {
  productId: string;
  productType: string | null;
  categoryName: string | null;
  /** What the type field holds now, if anything. */
  current: string[] | null;
}

export type TypeFieldChange =
  | { productId: string; kind: "set"; path: string[] }
  | { productId: string; kind: "clear" };

const same = (a: readonly string[] | null, b: readonly string[] | null) =>
  a === null || b === null
    ? a === b
    : a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * What each product's type field must become: the path of the type it is
 * matched to (chosen, or by category or Shopify product type, as the product
 * page decides), or nothing. A product two types claim keeps what it holds,
 * since guessing would move it between collections. Unchanged products are
 * left out, so a second run writes only what moved — including every
 * product beneath a type that was moved in the tree.
 */
export function typeFieldChanges(
  schema: AttributeSchema,
  products: readonly CatalogueProductForMenu[],
  chosen: ReadonlyMap<string, string>,
): TypeFieldChange[] {
  const changes: TypeFieldChange[] = [];
  for (const product of products) {
    const match = typeForProduct(schema, {
      categoryName: product.categoryName,
      categoryFullName: null,
      productType: product.productType,
      chosenTypeId: chosen.get(product.productId) ?? null,
    });
    if (match.kind === "ambiguous") continue;
    const wanted =
      match.kind === "matched" ? typePath(schema, match.typeId) : null;
    if (same(wanted, product.current)) continue;
    changes.push(
      wanted === null
        ? { productId: product.productId, kind: "clear" }
        : { productId: product.productId, kind: "set", path: wanted },
    );
  }
  return changes;
}
