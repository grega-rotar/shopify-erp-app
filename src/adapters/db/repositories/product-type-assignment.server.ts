import { prisma } from "~/adapters/db/client.server";
import { shopDomainOf, type Principal } from "~/domain/types";

/**
 * The product type a person chose for a product (docs/attributes.md § On
 * the product page). One row per shop and product; choosing again replaces
 * it, and clearing it hands the product back to the match by category or
 * Shopify product type.
 */

export async function assignedTypeFor(
  principal: Principal,
  productId: string,
): Promise<string | null> {
  const row = await prisma.productTypeAssignment.findFirst({
    where: { shop: { domain: shopDomainOf(principal) }, productId },
    select: { typeId: true },
  });
  return row?.typeId ?? null;
}

export async function assignType(
  principal: Principal,
  productId: string,
  typeId: string,
  chosenBy: string | null,
): Promise<void> {
  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomainOf(principal) },
    select: { id: true },
  });
  if (!shop) throw new Error(`Unknown shop ${shopDomainOf(principal)}`);
  await prisma.productTypeAssignment.upsert({
    where: { shopId_productId: { shopId: shop.id, productId } },
    create: { shopId: shop.id, productId, typeId, chosenBy },
    update: { typeId, chosenBy },
  });
}

export async function clearAssignedType(
  principal: Principal,
  productId: string,
): Promise<void> {
  await prisma.productTypeAssignment.deleteMany({
    where: { shop: { domain: shopDomainOf(principal) }, productId },
  });
}

/** The choices made for these products, with who made each. */
export async function assignmentsFor(
  principal: Principal,
  productIds: readonly string[],
): Promise<Map<string, { typeId: string; chosenBy: string | null }>> {
  if (productIds.length === 0) return new Map();
  const rows = await prisma.productTypeAssignment.findMany({
    where: {
      shop: { domain: shopDomainOf(principal) },
      productId: { in: [...productIds] },
    },
    select: { productId: true, typeId: true, chosenBy: true },
  });
  return new Map(
    rows.map((row) => [
      row.productId,
      { typeId: row.typeId, chosenBy: row.chosenBy },
    ]),
  );
}
