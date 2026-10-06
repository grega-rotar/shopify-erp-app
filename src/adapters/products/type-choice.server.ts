import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import { assignType } from "~/adapters/db/repositories/product-type-assignment.server";
import { getTypeMenu } from "~/adapters/db/repositories/type-menu.server";
import { getLogger } from "~/adapters/observability/logger.server";
import { writeMetafields } from "~/adapters/shopify/product-workspace";
import { MENU_TYPE_FIELD, typePath } from "~/domain/attributes/menu";
import type { AttributeSchema } from "~/domain/attributes/types";
import type { Principal } from "~/domain/types";

/**
 * Giving a product its type (docs/attributes.md § On the product page and
 * § Store menu). The product page and AI autofill both come through here,
 * so a type chosen either way is recorded the same and moves the product
 * into its menu collection the same.
 */
export async function chooseProductType(
  admin: AdminApiContext,
  principal: Principal,
  input: {
    schema: AttributeSchema;
    productId: string;
    typeId: string;
    chosenBy: string | null;
  },
): Promise<void> {
  await assignType(principal, input.productId, input.typeId, input.chosenBy);
  await moveIntoMenu(
    admin,
    principal,
    input.productId,
    typePath(input.schema, input.typeId),
  );
}

/**
 * Once the store menu exists, a chosen type moves the product into that
 * type's collection at once rather than at the next menu update. The choice
 * itself is already saved, so a refusal here is logged, not shown; the next
 * update writes it again.
 */
async function moveIntoMenu(
  admin: AdminApiContext,
  principal: Principal,
  productId: string,
  path: string[],
): Promise<void> {
  const menu = await getTypeMenu(principal);
  if (!menu?.definitionId) return;
  try {
    const outcome = await writeMetafields(
      admin,
      [
        {
          ownerId: productId,
          namespace: MENU_TYPE_FIELD.namespace,
          key: MENU_TYPE_FIELD.key,
          type: MENU_TYPE_FIELD.type,
          value: JSON.stringify(path),
        },
      ],
      [],
    );
    if (!outcome.ok)
      getLogger().warn(
        { productId, errors: outcome.errors },
        "Menu type field not written",
      );
  } catch (error) {
    getLogger().warn({ err: error, productId }, "Menu type field not written");
  }
}
