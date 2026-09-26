import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import { getLogger } from "~/adapters/observability/logger.server";
import { readMenus } from "~/adapters/shopify/store-context";
import {
  readTranslatableResources,
  readTranslatableResourcesByIds,
  type TranslatableResource,
} from "~/adapters/shopify/translations";
import type { SnapshotMenuItem } from "~/domain/translations/snapshot";

/**
 * The store's navigation as the tree it is (docs/translations.md § Editor):
 * every menu with its items nested under it, each carrying the translatable
 * resource Shopify holds for its title.
 *
 * A menu's title is a `MENU` resource named by the menu's own id, so those
 * are read by id. An item's title is a `LINK` resource, and how that id
 * relates to the `MenuItem` id the navigation query returns is not in
 * Shopify's reference (`Menu` and `Link` have `translations`; `MenuItem` has
 * none). Asking about a `MenuItem` id is not a question Shopify answers with
 * silence — it is a GraphQL error, which is what took this page down once —
 * so nothing is asked for by a guessed id: the `LINK` resources are
 * **listed** with the documented query and matched to the tree by the number
 * in their ids. An item nothing matches is listed as having nothing to
 * translate rather than pointed at a resource that may not be its own.
 *
 * Every read here fails soft. Navigation is one tab of a page with plenty
 * else to show, and a tree whose translations could not be read is still a
 * tree worth seeing; what failed is logged.
 */
export interface NavigationNode {
  /** The id in the navigation tree: a menu's or a menu item's. */
  nodeId: string;
  /** The resource Shopify translates, when it has one. */
  resourceId: string | null;
  kind: "MENU" | "LINK";
  title: string;
  /** 0 for a menu, 1 for its items, and so on. */
  depth: number;
  parentId: string | null;
  childCount: number;
  /** What an item points at: Shopify's `MenuItemType`, "COLLECTION", "HTTP"… */
  linkType: string | null;
}

export interface NavigationTree {
  nodes: NavigationNode[];
  /** The translatable resources behind the nodes, by resource id. */
  resources: Map<string, TranslatableResource>;
  /** Whether Shopify reported any menus at all. */
  readable: boolean;
}

/** `LINK` resources read per request, and the most pages read for one tree. */
const LINK_PAGE = 250;
const LINK_PAGES = 4;

/** The number in a Shopify id: `gid://shopify/MenuItem/42` → "42". */
function idNumber(gid: string): string | null {
  const match = /\/(\d+)(?:\?|$)/.exec(gid);
  return match?.[1] ?? null;
}

/** The store's `LINK` resources, by the number in their ids. */
async function readLinks(
  admin: AdminApiContext,
  locales: readonly string[],
): Promise<Map<string, TranslatableResource>> {
  const byNumber = new Map<string, TranslatableResource>();
  let after: string | null = null;
  for (let page = 0; page < LINK_PAGES; page += 1) {
    let read;
    try {
      read = await readTranslatableResources(admin, {
        type: "LINK",
        first: LINK_PAGE,
        after,
        locales,
      });
    } catch (error) {
      getLogger().warn(
        { err: error, page },
        "The store's menu links could not be read for the navigation tree",
      );
      return byNumber;
    }
    for (const resource of read.resources) {
      const number = idNumber(resource.resourceId);
      if (number && !byNumber.has(number)) byNumber.set(number, resource);
    }
    if (!read.hasNextPage || !read.endCursor) return byNumber;
    after = read.endCursor;
  }
  getLogger().warn(
    { read: byNumber.size },
    "More menu links than the navigation tree reads; the rest are listed untranslated",
  );
  return byNumber;
}

/** The menus' own resources, by menu id; nothing rather than a thrown read. */
async function readMenuResources(
  admin: AdminApiContext,
  ids: readonly string[],
  locales: readonly string[],
): Promise<Map<string, TranslatableResource>> {
  if (ids.length === 0) return new Map();
  try {
    const found = await readTranslatableResourcesByIds(admin, { ids, locales });
    return new Map(found.map((resource) => [resource.resourceId, resource]));
  } catch (error) {
    getLogger().warn(
      { err: error, ids: ids.length },
      "The menus' own titles could not be read for the navigation tree",
    );
    return new Map();
  }
}

export async function readNavigationTree(
  admin: AdminApiContext,
  locales: readonly string[],
): Promise<NavigationTree> {
  const menus = await readMenus(admin);
  if (menus.length === 0)
    return { nodes: [], resources: new Map(), readable: false };

  const nodes: NavigationNode[] = [];
  const walk = (
    item: SnapshotMenuItem,
    depth: number,
    parentId: string,
  ): void => {
    nodes.push({
      nodeId: item.id,
      resourceId: null,
      kind: "LINK",
      title: item.title,
      depth,
      parentId,
      childCount: item.items.length,
      linkType: item.type,
    });
    for (const child of item.items) walk(child, depth + 1, item.id);
  };
  for (const menu of menus) {
    nodes.push({
      nodeId: menu.id,
      resourceId: null,
      kind: "MENU",
      title: menu.title,
      depth: 0,
      parentId: null,
      childCount: menu.items.length,
      linkType: null,
    });
    for (const item of menu.items) walk(item, 1, menu.id);
  }

  const [menuResources, links] = await Promise.all([
    readMenuResources(
      admin,
      nodes.filter((node) => node.kind === "MENU").map((node) => node.nodeId),
      locales,
    ),
    readLinks(admin, locales),
  ]);

  const resources = new Map<string, TranslatableResource>();
  let matched = 0;
  for (const node of nodes) {
    const number = idNumber(node.nodeId);
    const resource =
      node.kind === "MENU"
        ? menuResources.get(node.nodeId)
        : number
          ? links.get(number)
          : undefined;
    if (!resource) continue;
    if (node.kind === "LINK") matched += 1;
    node.resourceId = resource.resourceId;
    resources.set(resource.resourceId, resource);
  }

  const items = nodes.filter((node) => node.kind === "LINK").length;
  if (items > 0 && matched === 0)
    getLogger().warn(
      { items, links: links.size },
      "No menu item matched a LINK resource; the tree lists items as untranslatable",
    );

  return { nodes, resources, readable: true };
}
