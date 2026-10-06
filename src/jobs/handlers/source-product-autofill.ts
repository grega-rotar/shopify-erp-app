import type { Job } from "pg-boss";

import { getSourceAutofill } from "~/adapters/db/repositories/source-autofill.server";
import { getLogger } from "~/adapters/observability/logger.server";
import {
  autofillAvailability,
  requestAutofill,
} from "~/adapters/products/autofill.server";
import { webhookJobSchema } from "~/adapters/shopify/compliance-payloads";
import { parseProductUpdate } from "~/adapters/shopify/product-payload";
import { sourceIdFromTags } from "~/domain/export-portal/review";
import { serviceToken } from "~/domain/types";

/**
 * products/create, for AI categorization per source (docs/sources.md § AI
 * categorization per source). A product the export portal created carries
 * `portal-source:<id>`; when that source is switched on here, the product
 * is put to AI autofill — suggestions only, waiting for review like any
 * other. Every other product is left alone.
 *
 * Quiet by design: a source switched off, a portal not connected or a
 * product without the tag is not a failure, only a product the setting
 * does not reach. Guarded by webhook id, so a redelivery asks once.
 */
export async function handleSourceProductAutofill(
  job: Job<unknown>,
): Promise<void> {
  const { shopDomain, payload } = webhookJobSchema.parse(job.data);
  const product = parseProductUpdate(payload);
  const sourceId = sourceIdFromTags(product.tags);
  if (!sourceId) return;

  const principal = serviceToken(shopDomain, "source-product-autofill");
  const setting = await getSourceAutofill(principal, sourceId);
  if (!setting.enabled) return;

  const available = await autofillAvailability(principal);
  if (!available.ok) {
    getLogger().info(
      { shop: shopDomain, sourceId, reason: available.message },
      "Source product not autofilled",
    );
    return;
  }
  await requestAutofill(principal, [product.productId], `source:${sourceId}`, {
    fillAttributes: setting.fillAttributes,
  });
}
