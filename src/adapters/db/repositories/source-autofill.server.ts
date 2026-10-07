import { prisma } from "~/adapters/db/client.server";
import { shopDomainOf, type Principal } from "~/domain/types";

/**
 * AI categorization per source (docs/sources.md § AI categorization per
 * source): whether a source's new products are put to AI autofill as they
 * arrive, and what it fills. The source itself is the export portal's; a
 * source with no row here is off.
 */

export interface SourceAutofillSetting {
  enabled: boolean;
  fillAttributes: boolean;
  /** Apply a confident suggestion at once (docs/attributes.md § AI autofill). */
  autoApply: boolean;
}

export const SOURCE_AUTOFILL_OFF: SourceAutofillSetting = {
  enabled: false,
  fillAttributes: true,
  autoApply: false,
};

const SELECT = {
  enabled: true,
  fillAttributes: true,
  autoApply: true,
} as const;

const scoped = (principal: Principal) => ({
  shop: { domain: shopDomainOf(principal) },
});

export async function listSourceAutofill(
  principal: Principal,
): Promise<Map<string, SourceAutofillSetting>> {
  const rows = await prisma.sourceAutofill.findMany({
    where: scoped(principal),
    select: { sourceId: true, ...SELECT },
  });
  return new Map(rows.map(({ sourceId, ...setting }) => [sourceId, setting]));
}

export async function getSourceAutofill(
  principal: Principal,
  sourceId: string,
): Promise<SourceAutofillSetting> {
  const row = await prisma.sourceAutofill.findFirst({
    where: { ...scoped(principal), sourceId },
    select: SELECT,
  });
  return row ?? SOURCE_AUTOFILL_OFF;
}

export async function setSourceAutofill(
  principal: Principal,
  sourceId: string,
  setting: SourceAutofillSetting,
  updatedBy: string | null,
): Promise<void> {
  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomainOf(principal) },
    select: { id: true },
  });
  if (!shop) throw new Error(`Unknown shop ${shopDomainOf(principal)}`);
  await prisma.sourceAutofill.upsert({
    where: { shopId_sourceId: { shopId: shop.id, sourceId } },
    create: { shopId: shop.id, sourceId, ...setting, updatedBy },
    update: { ...setting, updatedBy },
  });
}
