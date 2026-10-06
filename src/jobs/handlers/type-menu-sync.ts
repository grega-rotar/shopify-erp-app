import type { Job } from "pg-boss";
import { z } from "zod";

import { getAttributeSchema } from "~/adapters/db/repositories/attribute-schema.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import {
  catalogueForMenu,
  chosenTypes,
  getTypeMenu,
  updateTypeMenu,
  type TypeCollections,
} from "~/adapters/db/repositories/type-menu.server";
import { getLogger } from "~/adapters/observability/logger.server";
import { writeMetafields } from "~/adapters/shopify/product-workspace";
import { unauthenticated } from "~/adapters/shopify/shopify.server";
import {
  TypeMenuError,
  ensureTypeField,
  existingCollections,
  onlineStorePublication,
  publishCollection,
  removeLegacyTypeField,
  upsertMenu,
  upsertTypeCollection,
  type MenuLink,
} from "~/adapters/shopify/type-menu";
import {
  MENU_TYPE_FIELD,
  TYPE_MENU_HANDLE,
  TYPE_MENU_TITLE,
  menuTree,
  typeFieldChanges,
  type MenuNode,
} from "~/domain/attributes/menu";
import { serviceToken } from "~/domain/types";

export const typeMenuSyncJobSchema = z.object({
  shopDomain: z.string().min(1),
  requestedBy: z.string().nullable().default(null),
});

/** Products per progress write; `metafieldsSet` takes 25 a call. */
const BATCH = 100;

/** Shopify's answer for a product that has been deleted. */
const OWNER_GONE = /owner does not exist/i;

/**
 * Makes the store menu from the product type tree (docs/attributes.md
 * § Store menu), in three steps recorded on the shop's menu row:
 *
 * 1. **Products.** The type field's definition is made sure of, then every
 *    product whose type changed since the field was last written gets its
 *    type and every type above it, or loses them.
 * 2. **Collections.** Every type gets an automated collection of the
 *    products whose path includes it: its own and those beneath it. A collection this app made before is updated;
 *    one a merchant deleted is made again. New ones are published to the
 *    online store; a merchant who unpublished one keeps it that way.
 * 3. **Menu.** The tree, three levels deep, each entry linking its
 *    collection, replaces the items of the menu this app made.
 *
 * Every step finds what an earlier run made, so a retry or a second press
 * repeats nothing. Each collection is recorded as soon as it exists, so a
 * failure part way never makes a duplicate. A refusal Shopify explains is
 * shown to the merchant and not retried; anything else is retried.
 */
export async function handleTypeMenuSync(job: Job<unknown>): Promise<void> {
  const { shopDomain, requestedBy } = typeMenuSyncJobSchema.parse(job.data);
  const principal = serviceToken(shopDomain, "type-menu-sync");
  const log = getLogger();

  try {
    const { admin } = await unauthenticated.admin(shopDomain);
    const { schema } = await getAttributeSchema(principal);
    const state = await getTypeMenu(principal);
    if (!state) return;
    if (schema.types.length === 0)
      throw new TypeMenuError(
        "There are no product types to make a menu from. Add some first.",
      );

    /* 1. Products. */
    await updateTypeMenu(principal, {
      status: "running",
      phase: "products",
      done: 0,
      total: 0,
    });
    const definitionId = await ensureTypeField(admin);
    await updateTypeMenu(principal, { definitionId });

    const changes = typeFieldChanges(
      schema,
      await catalogueForMenu(principal),
      await chosenTypes(principal),
    );
    await updateTypeMenu(principal, { total: changes.length });
    const field = {
      namespace: MENU_TYPE_FIELD.namespace,
      key: MENU_TYPE_FIELD.key,
    };
    const write = (batch: typeof changes) =>
      writeMetafields(
        admin,
        batch.flatMap((change) =>
          change.kind === "set"
            ? [
                {
                  ownerId: change.productId,
                  ...field,
                  type: MENU_TYPE_FIELD.type,
                  value: JSON.stringify(change.path),
                },
              ]
            : [],
        ),
        batch.flatMap((change) =>
          change.kind === "clear"
            ? [{ ownerId: change.productId, ...field }]
            : [],
        ),
      );
    // The catalogue can still hold a product Shopify has since deleted;
    // Shopify then refuses the whole call. A refused batch is written one
    // product at a time, and a product that no longer exists is skipped
    // and counted rather than stopping the menu.
    let gone = 0;
    for (let start = 0; start < changes.length; start += BATCH) {
      const batch = changes.slice(start, start + BATCH);
      const outcome = await write(batch);
      if (!outcome.ok)
        for (const change of batch) {
          const single = await write([change]);
          if (single.ok) continue;
          if (single.errors.every((e) => OWNER_GONE.test(e.message))) {
            gone++;
            continue;
          }
          throw new TypeMenuError(
            `Shopify refused a product's type: ${single.errors.map((e) => e.message).join("; ")}`,
          );
        }
      await updateTypeMenu(principal, { done: start + batch.length });
    }

    /* 2. Collections. */
    await updateTypeMenu(principal, {
      phase: "collections",
      done: 0,
      total: schema.types.length,
    });
    const recorded = state.collections;
    const alive = await existingCollections(
      admin,
      Object.values(recorded).map((c) => c.collectionId),
    );
    const publicationId = await onlineStorePublication(admin);
    const collections: TypeCollections = {};
    let done = 0;
    for (const type of schema.types) {
      const previous = recorded[type.id];
      const existing =
        previous && alive.has(previous.collectionId) ? previous : null;
      const collection = await upsertTypeCollection(admin, {
        existing,
        title: type.name,
        definitionId,
        typeId: type.id,
      });
      if (!existing && publicationId)
        await publishCollection(admin, collection.collectionId, publicationId);
      collections[type.id] = collection;
      done++;
      // Recorded as it goes, with the ones not reached yet kept, so a
      // failure part way leaves nothing this app made unaccounted for.
      await updateTypeMenu(principal, {
        collections: { ...recorded, ...collections },
        done,
      });
    }

    /* 3. Menu. */
    await updateTypeMenu(principal, { phase: "menu", done: 0, total: 1 });
    const links = (nodes: readonly MenuNode[]): MenuLink[] =>
      nodes.flatMap((node) => {
        const collection = collections[node.typeId];
        return collection
          ? [
              {
                title: node.title,
                collectionId: collection.collectionId,
                items: links(node.children),
              },
            ]
          : [];
      });
    const menuId = await upsertMenu(admin, {
      menuId: state.menuId,
      title: TYPE_MENU_TITLE,
      handle: TYPE_MENU_HANDLE,
      links: links(menuTree(schema)),
    });

    // The first version's single-value field goes once no collection
    // matches on it any more. Leftover data, so a refusal is only logged.
    try {
      await removeLegacyTypeField(admin);
    } catch (error) {
      log.warn({ err: error, shopDomain }, "legacy menu type field kept");
    }

    // Only types still in the plan are remembered; collections made for
    // types since deleted stay in Shopify for the merchant to remove.
    await updateTypeMenu(principal, {
      menuId,
      collections,
      status: "done",
      phase: null,
      done: 1,
      lastError:
        [
          publicationId
            ? null
            : "The collections were made but not published: the online store sales channel was not found. Publish them from Collections in Shopify.",
          gone > 0
            ? `${gone} ${gone === 1 ? "product" : "products"} in the app's catalogue no longer ${gone === 1 ? "exists" : "exist"} in Shopify and ${gone === 1 ? "was" : "were"} skipped; the next catalogue refresh drops ${gone === 1 ? "it" : "them"}.`
            : null,
        ]
          .filter(Boolean)
          .join(" ") || null,
      finishedAt: new Date(),
    });
    await appendEvent(principal, {
      entityType: "attribute_schema",
      event: "attribute_schema.menu_made",
      detail: {
        by: requestedBy,
        products: changes.length,
        collections: Object.keys(collections).length,
        menuId,
      },
    });
  } catch (error) {
    const explained = error instanceof TypeMenuError;
    log.error({ err: error, shopDomain }, "type menu sync failed");
    await updateTypeMenu(principal, {
      status: "failed",
      lastError: explained
        ? error.message
        : "Something went wrong while making the menu. Try again; what was already made is kept.",
      finishedAt: new Date(),
    });
    if (!explained) throw error;
  }
}
