import type { Job } from "pg-boss";
import { z } from "zod";

import { failAutofill } from "~/adapters/db/repositories/product-autofill.server";
import { getLogger } from "~/adapters/observability/logger.server";
import { suggestAutofill } from "~/adapters/products/autofill.server";
import { enqueue } from "~/adapters/queue/boss.server";
import { QUEUES } from "~/adapters/queue/queues";
import { unauthenticated } from "~/adapters/shopify/shopify.server";
import { serviceToken } from "~/domain/types";

export const productAutofillJobSchema = z.object({
  shopDomain: z.string().min(1),
  productIds: z.array(z.string().min(1)).min(1).max(250),
  /** False for a source set to suggest the type only. */
  fillAttributes: z.boolean().default(true),
});

/** Products per pass: a categorize batch, then one attribute call each. */
const PASS = 10;

/**
 * AI autofill for a list of products (docs/attributes.md § AI autofill): a
 * pass suggests for the first ten and hands the rest to a fresh job, so a
 * long list never outlives a job's expiry and a crash costs ten products,
 * not all of them. Each product's suggestion or failure is recorded on its
 * `product_autofill` row, which is what the pages watch.
 *
 * Failures the portal or Shopify explain are recorded per product inside
 * `suggestAutofill`. Anything else marks the pass's products failed — a
 * person presses again — rather than retrying the AI calls unseen and
 * leaving the products shown as queued meanwhile.
 */
export async function handleProductAutofill(job: Job<unknown>): Promise<void> {
  const { shopDomain, productIds, fillAttributes } =
    productAutofillJobSchema.parse(job.data);
  const principal = serviceToken(shopDomain, "product-autofill");
  const pass = productIds.slice(0, PASS);
  const rest = productIds.slice(PASS);

  try {
    const { admin } = await unauthenticated.admin(shopDomain);
    await suggestAutofill(admin, principal, pass, { fillAttributes });
  } catch (error) {
    getLogger().error({ err: error, shopDomain }, "Product autofill pass failed");
    for (const id of pass)
      await failAutofill(
        principal,
        id,
        "Suggestions could not be made just now. Try again.",
      );
  }

  if (rest.length > 0)
    await enqueue(QUEUES.productAutofill, {
      shopDomain,
      productIds: rest,
      fillAttributes,
    });
}
