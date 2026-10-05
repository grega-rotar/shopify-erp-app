import type { Prisma } from "@prisma/client";

import { prisma } from "~/adapters/db/client.server";
import { shopDomainOf, type Principal } from "~/domain/types";

/**
 * What the product pages read from this app's own tables
 * (docs/architecture.md § Product workspace): the catalogue snapshot as a
 * list, the SKU registry for one product's variants, the sale rows that
 * touch it, and its trail. Tenant-scoped at this boundary like every
 * repository here.
 */

async function shopIdFor(principal: Principal): Promise<string> {
  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomainOf(principal) },
    select: { id: true },
  });
  if (!shop) throw new Error(`Unknown shop ${shopDomainOf(principal)}`);
  return shop.id;
}

/* -------------------------------------------------------------------------- */
/* The product list                                                           */
/* -------------------------------------------------------------------------- */

export const PRODUCT_STATUS_FILTERS = [
  "all",
  "active",
  "draft",
  "archived",
] as const;
export type ProductStatusFilter = (typeof PRODUCT_STATUS_FILTERS)[number];

export interface ProductListQuery {
  q: string;
  status: ProductStatusFilter;
  page: number;
  pageSize: number;
}

export interface ProductListRow {
  productId: string;
  title: string;
  vendor: string | null;
  productType: string | null;
  status: string | null;
  imageUrl: string | null;
  variants: number;
  /** The one SKU of a single-variant product; null otherwise. */
  sku: string | null;
  minPriceMinor: number | null;
  maxPriceMinor: number | null;
  currency: string | null;
}

export interface ProductListPage {
  rows: ProductListRow[];
  total: number;
  snapshotAt: Date | null;
}

/**
 * One page of the catalogue snapshot, searched by title, vendor, product
 * type or any variant's SKU. The snapshot is what the list reads: it is
 * kept current by `products/update` and re-read nightly, and a list of
 * every product is not a page load that should wait on Shopify.
 */
export async function listCatalogueProducts(
  principal: Principal,
  query: ProductListQuery,
): Promise<ProductListPage> {
  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomainOf(principal) },
    select: { id: true, catalogueSnapshotAt: true },
  });
  if (!shop) throw new Error(`Unknown shop ${shopDomainOf(principal)}`);

  const q = query.q.trim();
  const where: Prisma.CatalogProductWhereInput = {
    shopId: shop.id,
    ...(query.status === "all" ? {} : { status: query.status.toUpperCase() }),
    ...(q === ""
      ? {}
      : {
          OR: [
            { title: { contains: q, mode: "insensitive" } },
            { vendor: { contains: q, mode: "insensitive" } },
            { productType: { contains: q, mode: "insensitive" } },
            {
              variants: {
                some: { sku: { contains: q, mode: "insensitive" } },
              },
            },
          ],
        }),
  };

  const [total, products] = await Promise.all([
    prisma.catalogProduct.count({ where }),
    prisma.catalogProduct.findMany({
      where,
      orderBy: [{ title: "asc" }, { shopifyProductId: "asc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: {
        shopifyProductId: true,
        title: true,
        vendor: true,
        productType: true,
        status: true,
        imageUrl: true,
        variants: {
          select: { sku: true, priceMinor: true, currency: true },
        },
      },
    }),
  ]);

  return {
    total,
    snapshotAt: shop.catalogueSnapshotAt,
    rows: products.map((product) => {
      const prices = product.variants.map((v) => v.priceMinor);
      return {
        productId: product.shopifyProductId,
        title: product.title,
        vendor: product.vendor,
        productType: product.productType,
        status: product.status,
        imageUrl: product.imageUrl,
        variants: product.variants.length,
        sku:
          product.variants.length === 1
            ? (product.variants[0]?.sku ?? null)
            : null,
        minPriceMinor: prices.length > 0 ? Math.min(...prices) : null,
        maxPriceMinor: prices.length > 0 ? Math.max(...prices) : null,
        currency: product.variants[0]?.currency ?? null,
      };
    }),
  };
}

/* -------------------------------------------------------------------------- */
/* One product                                                                */
/* -------------------------------------------------------------------------- */

export interface RegistryRow {
  sku: string;
  status: "matched" | "unmatched" | "ignored";
  metakockaCode: string | null;
  metakockaName: string | null;
  updatedAt: Date;
}

/** The SKU registry's rows for these SKUs, keyed by SKU. */
export async function registryFor(
  principal: Principal,
  skus: readonly string[],
): Promise<Map<string, RegistryRow>> {
  if (skus.length === 0) return new Map();
  const shopId = await shopIdFor(principal);
  const rows = await prisma.sku.findMany({
    where: { shopId, sku: { in: [...new Set(skus)] } },
    select: {
      sku: true,
      status: true,
      metakockaCode: true,
      metakockaName: true,
      updatedAt: true,
    },
  });
  return new Map(rows.map((row) => [row.sku, row]));
}

/** When the catalogue was last read and matched, from the trail. */
export async function lastCatalogueRead(
  principal: Principal,
): Promise<Date | null> {
  const shopId = await shopIdFor(principal);
  const row = await prisma.eventLog.findFirst({
    where: { shopId, event: "catalogue.synced" },
    orderBy: { at: "desc" },
    select: { at: true },
  });
  return row?.at ?? null;
}

/** States in which a campaign row says something about a variant now or soon. */
const SALE_STATES = [
  "pending",
  "applying",
  "applied",
  "review",
  "restoring",
  "restore_failed",
] as const;

export interface SaleRow {
  variantId: string;
  state: string;
  originalPriceMinor: number | null;
  originalCompareAtMinor: number | null;
  salePriceMinor: number | null;
  currency: string;
  campaign: {
    id: string;
    name: string;
    status: string;
    discountType: string;
    discountValue: number;
    startsAt: Date | null;
    endsAt: Date | null;
  };
}

/**
 * Every sale row that touches the product: the one live owner of each
 * variant it has, and rows a scheduled or running campaign has staged.
 */
export async function saleRowsForProduct(
  principal: Principal,
  productId: string,
): Promise<SaleRow[]> {
  const shopId = await shopIdFor(principal);
  return prisma.saleCampaignVariant.findMany({
    where: {
      shopId,
      productId,
      state: { in: [...SALE_STATES] },
      campaign: { status: { notIn: ["draft", "cancelled", "completed"] } },
    },
    select: {
      variantId: true,
      state: true,
      originalPriceMinor: true,
      originalCompareAtMinor: true,
      salePriceMinor: true,
      currency: true,
      campaign: {
        select: {
          id: true,
          name: true,
          status: true,
          discountType: true,
          discountValue: true,
          startsAt: true,
          endsAt: true,
        },
      },
    },
  });
}

/** The live owners of these variants' prices, read at save time. */
export async function liveHolds(
  principal: Principal,
  variantIds: readonly string[],
): Promise<
  Map<string, { campaignId: string; campaignName: string; state: string }>
> {
  if (variantIds.length === 0) return new Map();
  const shopId = await shopIdFor(principal);
  const rows = await prisma.saleCampaignVariant.findMany({
    where: {
      shopId,
      variantId: { in: [...variantIds] },
      state: {
        in: ["applying", "applied", "review", "restoring", "restore_failed"],
      },
    },
    select: {
      variantId: true,
      state: true,
      campaign: { select: { id: true, name: true } },
    },
  });
  return new Map(
    rows.map((row) => [
      row.variantId,
      {
        campaignId: row.campaign.id,
        campaignName: row.campaign.name,
        state: row.state,
      },
    ]),
  );
}

export interface ProductTrailEntry {
  id: string;
  at: Date;
  entityType: string;
  entityId: string | null;
  event: string;
  detail: Prisma.JsonValue;
}

/**
 * The trail of one product: entries about the product itself, its
 * translations (keyed by the product's id, which is also its translatable
 * resource id) and its variants' prices.
 */
export async function trailForProduct(
  principal: Principal,
  productId: string,
  variantIds: readonly string[],
  limit: number,
): Promise<ProductTrailEntry[]> {
  const shopId = await shopIdFor(principal);
  return prisma.eventLog.findMany({
    where: {
      shopId,
      OR: [
        { entityType: { in: ["product", "translation"] }, entityId: productId },
        ...(variantIds.length > 0
          ? [{ entityType: "sale_variant", entityId: { in: [...variantIds] } }]
          : []),
      ],
    },
    orderBy: { at: "desc" },
    take: limit,
    select: {
      id: true,
      at: true,
      entityType: true,
      entityId: true,
      event: true,
      detail: true,
    },
  });
}

export interface TranslationWork {
  id: string;
  at: Date;
  locale: string;
  status: string;
  fields: number;
}

/** What the AI did to this product, newest first: translation sync items. */
export async function translationWorkFor(
  principal: Principal,
  resourceId: string,
  limit: number,
): Promise<TranslationWork[]> {
  const shopId = await shopIdFor(principal);
  const rows = await prisma.translationSyncItem.findMany({
    where: {
      shopId,
      resourceId,
      status: { in: ["translated", "copied", "failed"] },
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      createdAt: true,
      locale: true,
      status: true,
      fields: true,
    },
  });
  return rows.map((row) => ({
    id: row.id,
    at: row.createdAt,
    locale: row.locale,
    status: row.status,
    fields: row.fields,
  }));
}
