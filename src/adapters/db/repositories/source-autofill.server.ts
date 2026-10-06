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
}

export const SOURCE_AUTOFILL_OFF: SourceAutofillSetting = {
  enabled: false,
  fillAttributes: true,
};

const scoped = (principal: Principal) => ({
  shop: { domain: shopDomainOf(principal) },
});

export async function listSourceAutofill(
  principal: Principal,
): Promise<Map<string, SourceAutofillSetting>> {
  const rows = await prisma.sourceAutofill.findMany({
    where: scoped(principal),
    select: { sourceId: true, enabled: true, fillAttributes: true },
  });
  return new Map(
    rows.map((row) => [
      row.sourceId,
      { enabled: row.enabled, fillAttributes: row.fillAttributes },
    ]),
  );
}

export async function getSourceAutofill(
  principal: Principal,
  sourceId: string,
): Promise<SourceAutofillSetting> {
  const row = await prisma.sourceAutofill.findFirst({
    where: { ...scoped(principal), sourceId },
    select: { enabled: true, fillAttributes: true },
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
