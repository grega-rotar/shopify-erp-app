import type { Job } from "pg-boss";

import { isConfigured } from "~/adapters/ai/openai.server";
import { prisma } from "~/adapters/db/client.server";
import {
  listLanguageSettings,
  wroteResourceSince,
} from "~/adapters/db/repositories/translations.server";
import { getLogger } from "~/adapters/observability/logger.server";
import { webhookJobSchema } from "~/adapters/shopify/compliance-payloads";
import { listShopLocales } from "~/adapters/shopify/locales";
import {
  normaliseTopic,
  parseProductDelete,
} from "~/adapters/shopify/product-payload";
import { unauthenticated } from "~/adapters/shopify/shopify.server";
import { collectChangedResource } from "~/adapters/translations/syncs.server";
import type { SyncMode } from "~/domain/translations/types";
import { serviceToken } from "~/domain/types";

/**
 * A product was created or changed in Shopify (docs/translations.md
 * § Automatic translation).
 *
 * For every language with automatic translation on, the product goes on
 * the sync that is collecting changed products — one `resource` sync per
 * mode, which runs a couple of minutes after it was opened and translates
 * everything that arrived meanwhile: the product's missing fields, and its
 * outdated ones where the language asks for that. A language's overwrite
 * policy applies unchanged: an edit a person made is never replaced from
 * here.
 *
 * Shopify also sends this webhook when *this app* registers a product's
 * translations. That echo is recognised by the ownership record the engine
 * wrote moments before and dropped; otherwise a store-wide sync would be
 * followed by a sync of every product it touched, each finding nothing to do.
 *
 * Deletes are ignored; Shopify removes the translations with the product.
 * Collections, pages and articles have no webhook here and are picked up by
 * the nightly automatic sync instead.
 */

/** A change this soon after the engine wrote the product is the engine's own write. */
const ECHO_WINDOW_MS = 15 * 60 * 1000;

export async function handleTranslationResourceEvent(
  job: Job<unknown>,
): Promise<void> {
  const { shopDomain, topic, payload } = webhookJobSchema.parse(job.data);
  const principal = serviceToken(shopDomain, "translation-resource-event");
  const log = getLogger();

  if (normaliseTopic(topic) === "products/delete") return;
  if (!isConfigured()) return;

  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomain },
    select: { id: true },
  });
  if (!shop) return;

  const automatic = (await listLanguageSettings(principal)).filter(
    (language) =>
      language.aiEnabled &&
      language.autoTranslateNew &&
      language.contentScope.includes("products"),
  );
  if (automatic.length === 0) return;

  // Only the id is needed from the payload; the content is read back from
  // Shopify with its digests, which the webhook does not carry.
  const { productId } = parseProductDelete(payload);

  if (
    await wroteResourceSince(
      principal,
      productId,
      new Date(Date.now() - ECHO_WINDOW_MS),
    )
  ) {
    log.debug(
      { shop: shopDomain, productId },
      "Product change is this app's own write",
    );
    return;
  }

  const { admin } = await unauthenticated.admin(shopDomain);
  const locales = await listShopLocales(admin);
  if (locales.kind === "unavailable") {
    log.warn({ shop: shopDomain, reason: locales.reason }, "Locales not read");
    return;
  }
  const primary = locales.locales.find((locale) => locale.primary);
  if (!primary) return;
  const enabled = new Set(locales.locales.map((locale) => locale.locale));

  // One sync per mode: a language that wants outdated translations refreshed
  // and one that does not cannot share a plan.
  const byMode = new Map<SyncMode, string[]>();
  for (const language of automatic) {
    if (!enabled.has(language.locale) || language.locale === primary.locale)
      continue;
    const mode: SyncMode = language.autoUpdateOutdated
      ? "missing_outdated"
      : "missing";
    byMode.set(mode, [...(byMode.get(mode) ?? []), language.locale].sort());
  }

  for (const [mode, targetLocales] of byMode) {
    const result = await collectChangedResource(principal, {
      resourceId: productId,
      resourceType: "PRODUCT",
      sourceLocale: primary.locale,
      targetLocales,
      mode,
    });
    log.info(
      {
        shop: shopDomain,
        productId,
        mode,
        syncId: result.sync.id,
        opened: result.opened,
        added: result.added,
        resources: result.sync.resourceIds.length,
      },
      "Product change collected for translation",
    );
  }
}
