import type { Job } from "pg-boss";
import { z } from "zod";

import { prisma } from "~/adapters/db/client.server";
import {
  listLanguageSettings,
  replaceCoverage,
} from "~/adapters/db/repositories/translations.server";
import { getLogger } from "~/adapters/observability/logger.server";
import { listShopLocales } from "~/adapters/shopify/locales";
import { unauthenticated } from "~/adapters/shopify/shopify.server";
import {
  describeUnread,
  scanCoverage,
} from "~/adapters/translations/coverage.server";
import { ALL_RESOURCE_TYPES } from "~/domain/translations/types";
import { serviceToken } from "~/domain/types";

export const translationCoverageJobSchema = z.object({
  shopDomain: z.string().min(1),
});

/**
 * Re-reads the coverage cache (docs/translations.md § Coverage): one pass
 * over every translatable resource, counting per language and type. Asked
 * for after a sync completes, from the Languages page, and nightly; throttled
 * so a busy afternoon does not scan the store ten times.
 *
 * What was read is kept even when a type could not be: the cache is
 * replaced with the types that were counted, then the job fails naming the
 * rest, so the Languages page shows the counts it has and the reason it
 * does not have the others (`coverageCountState`).
 */
export async function handleTranslationCoverage(
  job: Job<unknown>,
): Promise<void> {
  const { shopDomain } = translationCoverageJobSchema.parse(job.data);
  const principal = serviceToken(shopDomain, "translation-coverage");
  const log = getLogger();

  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomain },
    select: { id: true },
  });
  if (!shop) return;

  const { admin } = await unauthenticated.admin(shopDomain);
  const locales = await listShopLocales(admin);
  if (locales.kind === "unavailable") {
    // Failing, not returning: a job that ends quietly looks like a count
    // that never happened.
    throw new Error(
      `The store's languages could not be read. ${locales.reason}`,
    );
  }
  const targets = locales.locales
    .filter((locale) => !locale.primary)
    .map((locale) => locale.locale);

  const settings = await listLanguageSettings(principal);
  const scan = await scanCoverage(
    admin,
    {
      types: ALL_RESOURCE_TYPES,
      locales: targets,
      keepOriginal: new Map(settings.map((row) => [row.locale, row.keepOriginal])),
    },
    (done) => log.debug({ shop: shopDomain, ...done }, "Coverage read"),
  );
  // Nothing read means nothing to replace the old counts with; they stay.
  const readNothing =
    scan.unread.length > 0 && scan.unread.length === ALL_RESOURCE_TYPES.length;
  if (!readNothing) await replaceCoverage(principal, scan.rows, new Date());
  log.info(
    {
      shop: shopDomain,
      locales: targets.length,
      rows: scan.rows.length,
      unread: scan.unread.map((entry) => entry.type),
    },
    "Translation coverage replaced",
  );
  if (scan.unread.length > 0) {
    log.warn({ shop: shopDomain, unread: scan.unread }, "Coverage partly read");
    throw new Error(
      `${readNothing ? "Nothing" : "Some content"} could not be read from Shopify. ${describeUnread(scan.unread)}`,
    );
  }
}
