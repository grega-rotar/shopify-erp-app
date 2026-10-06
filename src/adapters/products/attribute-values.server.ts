import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import { getLogger } from "~/adapters/observability/logger.server";
import { listMetafieldDefinitions } from "~/adapters/shopify/products";
import {
  readVariantMetafields,
  type WorkspaceProduct,
} from "~/adapters/shopify/product-workspace";
import { activeAttributes } from "~/domain/attributes/resolve";
import type { AttributeSchema } from "~/domain/attributes/types";
import {
  attributeFields,
  inputsFrom,
  type AttributeField,
  type AttributeInputs,
} from "~/domain/products/attribute-values";
import type { MetafieldMap } from "~/domain/sales/types";

/**
 * A product's attribute values as the editor needs them (docs/attributes.md
 * § On the product page): the fields of its type with the Shopify type each
 * is written as, and what each holds now. The page load and the save read
 * through this one path, so a save compares against what the page showed.
 *
 * Fails soft. Without the shop's metafield definitions a field falls back
 * to the type of a value already stored, then to the attribute's format,
 * and Shopify refuses a mismatch on save. Without the variants' values the
 * variant fields are shown but not editable, since an empty field there
 * would be a guess.
 */
export interface AttributeValues {
  fields: AttributeField[];
  inputs: AttributeInputs;
  /** Per variant, the metafields the plan asks of variants. */
  variantMetafields: MetafieldMap[];
  variantDetailsRead: boolean;
}

export async function readAttributeValues(
  admin: AdminApiContext,
  plan: AttributeSchema,
  typeId: string,
  product: WorkspaceProduct,
): Promise<AttributeValues> {
  const variantIds = product.variants.map((variant) => variant.variantId);
  const variantKeys = activeAttributes(plan, typeId)
    .filter(
      (row) =>
        row.attribute.scope === "variant" && row.attribute.key.trim() !== "",
    )
    .map((row) => row.attribute.key.trim());

  const [definitions, variantRead] = await Promise.all([
    listMetafieldDefinitions(admin).then(
      (list) =>
        new Map(
          list.flatMap((definition) =>
            definition.type
              ? [
                  [
                    `${definition.ownerType}|${definition.namespace}.${definition.key}`,
                    definition.type,
                  ] as const,
                ]
              : [],
          ),
        ),
      (error: unknown) => {
        getLogger().warn(
          { err: error },
          "Metafield definitions could not be read for the product workspace",
        );
        return new Map<string, string>();
      },
    ),
    variantKeys.length > 0
      ? readVariantMetafields(admin, variantIds, variantKeys).then(
          (map) => ({ ok: true as const, map }),
          (error: unknown) => {
            getLogger().warn(
              { err: error },
              "Variant metafields could not be read for the product workspace",
            );
            return { ok: false as const, map: new Map<string, MetafieldMap>() };
          },
        )
      : Promise.resolve({
          ok: true as const,
          map: new Map<string, MetafieldMap>(),
        }),
  ]);

  const variants = variantIds.map((id) => ({
    variantId: id,
    metafields: variantRead.map.get(id) ?? {},
  }));
  const fields = attributeFields(plan, typeId, {
    definitions,
    product: product.metafields,
    variants: variants.map((variant) => variant.metafields),
  }).map((field) =>
    field.scope === "variant" && !variantRead.ok
      ? {
          ...field,
          edit: {
            kind: "blocked" as const,
            reason:
              "Variant values could not be read just now. Reload to try again.",
          },
        }
      : field,
  );

  return {
    fields,
    inputs: inputsFrom(fields, product.metafields, variants),
    variantMetafields: variants.map((variant) => variant.metafields),
    variantDetailsRead: variantRead.ok,
  };
}
