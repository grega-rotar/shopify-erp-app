import type { Job } from "pg-boss";
import { z } from "zod";

import { prisma } from "~/adapters/db/client.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import { clearFailure } from "~/adapters/db/repositories/translation-failures.server";
import { forgetOwnership } from "~/adapters/db/repositories/translations.server";
import { getLogger } from "~/adapters/observability/logger.server";
import { enqueue } from "~/adapters/queue/boss.server";
import { QUEUES, translationRemoveKey } from "~/adapters/queue/queues";
import { unauthenticated } from "~/adapters/shopify/shopify.server";
import {
  isLocaleCode,
  readTranslatableResources,
  removeTranslations,
} from "~/adapters/shopify/translations";
import { requestCoverageRefresh } from "~/adapters/translations/syncs.server";
import { ALL_RESOURCE_TYPES } from "~/domain/translations/types";
import { serviceToken } from "~/domain/types";

export const translationRemoveJobSchema = z.object({
  shopDomain: z.string().min(1),
  locale: z.string().refine(isLocaleCode),
  requestedBy: z.string().nullable(),
  typeIndex: z.number().int().min(0).default(0),
  after: z.string().nullable().default(null),
  removed: z.number().int().min(0).default(0),
  refused: z.number().int().min(0).default(0),
});

/** Resources per pass; each is at most one `translationsRemove`. */
const PAGE = 50;

/**
 * Deletes every translation in one language (docs/translations.md § Delete
 * all translations), a page of resources per pass, re-enqueueing itself
 * with its cursor in the job data like the sync does. Every content type
 * this app works with is walked, whether or not it is in the language's
 * scope. What this app knew about the removed translations — ownership, a
 * remembered failure — goes with them.
 *
 * A resource Shopify refuses is counted and skipped, not retried for ever;
 * the event at the end says how many. A repeated page removes nothing
 * twice: what is already gone is simply not there to remove.
 */
export async function handleTranslationRemove(job: Job<unknown>): Promise<void> {
  const data = translationRemoveJobSchema.parse(job.data);
  const { shopDomain, locale } = data;
  const principal = serviceToken(shopDomain, "translation-remove");
  const log = getLogger();

  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomain },
    select: { id: true },
  });
  if (!shop) return;

  const type = ALL_RESOURCE_TYPES[data.typeIndex];
  if (type === undefined) {
    await finish(principal, data);
    return;
  }

  const { admin } = await unauthenticated.admin(shopDomain);
  const page = await readTranslatableResources(admin, {
    type,
    first: PAGE,
    after: data.after,
    locales: [locale],
  });

  let removed = data.removed;
  let refused = data.refused;
  for (const resource of page.resources) {
    const keys = (resource.translations.get(locale) ?? [])
      .filter((translation) => translation.value !== "")
      .map((translation) => translation.key);
    if (keys.length === 0) continue;
    const result = await removeTranslations(admin, resource.resourceId, [locale], keys);
    if (result.kind === "rejected") {
      refused += 1;
      log.warn(
        { shop: shopDomain, locale, resourceId: resource.resourceId, messages: result.messages },
        "Shopify refused to remove translations",
      );
      continue;
    }
    removed += keys.length;
    await forgetOwnership(principal, resource.resourceId, locale, keys);
    await clearFailure(principal, resource.resourceId, locale);
  }

  const next =
    page.hasNextPage && page.endCursor
      ? { typeIndex: data.typeIndex, after: page.endCursor }
      : { typeIndex: data.typeIndex + 1, after: null };
  const following = { ...data, ...next, removed, refused };
  if (next.typeIndex >= ALL_RESOURCE_TYPES.length) {
    await finish(principal, following);
    return;
  }
  await enqueue(QUEUES.translationRemove, following, {
    singletonKey: translationRemoveKey(shopDomain, locale),
  });
}

async function finish(
  principal: ReturnType<typeof serviceToken>,
  data: z.infer<typeof translationRemoveJobSchema>,
): Promise<void> {
  await appendEvent(principal, {
    entityType: "translation_language",
    entityId: data.locale,
    event: "translation_language.translations_removed",
    detail: { by: data.requestedBy, removed: data.removed, refused: data.refused },
  });
  getLogger().info(
    { shop: data.shopDomain, locale: data.locale, removed: data.removed, refused: data.refused },
    "Translations removed",
  );
  await requestCoverageRefresh(principal, 60);
}
