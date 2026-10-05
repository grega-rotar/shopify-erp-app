import type { Prisma } from "@prisma/client";

import { prisma } from "~/adapters/db/client.server";
import type {
  ProductFilters,
  ProductSort,
} from "~/domain/products/product-list";
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
  /** Leaves archived products out of "all"; ignored by any other status. */
  hideArchived: boolean;
  filters: ProductFilters;
  sort: ProductSort;
  page: number;
  pageSize: number;
}

export interface ProductListRow {
  productId: string;
  title: string;
  vendor: string | null;
  productType: string | null;
  categoryName: string | null;
  status: string | null;
  tags: string[];
  imageUrl: string | null;
  variants: number;
  /** The one SKU of a single-variant product; null otherwise. */
  sku: string | null;
  minPriceMinor: number | null;
  maxPriceMinor: number | null;
  currency: string | null;
  updatedAt: Date | null;
}

export interface ProductListPage {
  rows: ProductListRow[];
  total: number;
  snapshotAt: Date | null;
}

function orderFor(
  sort: ProductSort,
): Prisma.CatalogProductOrderByWithRelationInput[] {
  const nullsLast = { sort: sort.direction, nulls: "last" } as const;
  const tiebreak: Prisma.CatalogProductOrderByWithRelationInput[] = [
    { title: "asc" },
    { shopifyProductId: "asc" },
  ];
  switch (sort.key) {
    case "title":
      return [{ title: sort.direction }, { shopifyProductId: "asc" }];
    case "updated":
      return [{ shopifyUpdatedAt: nullsLast }, ...tiebreak];
    case "productType":
      return [{ productType: nullsLast }, ...tiebreak];
    case "vendor":
      return [{ vendor: nullsLast }, ...tiebreak];
    case "category":
      return [{ categoryName: nullsLast }, ...tiebreak];
  }
}

/**
 * One page of the catalogue snapshot, searched by title, vendor, product
 * type or any variant's SKU, narrowed by status and facets, and sorted.
 * The snapshot is what the list reads: it is kept current by
 * `products/update` and re-read nightly, and a list of every product is not
 * a page load that should wait on Shopify.
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
  const { filters } = query;
  const and: Prisma.CatalogProductWhereInput[] = [];
  if (query.status !== "all") {
    and.push({ status: query.status.toUpperCase() });
  } else if (query.hideArchived) {
    and.push({ OR: [{ status: null }, { status: { not: "ARCHIVED" } }] });
  }
  if (filters.vendor.length > 0) and.push({ vendor: { in: filters.vendor } });
  if (filters.productType.length > 0) {
    and.push({ productType: { in: filters.productType } });
  }
  if (filters.category.length > 0) {
    and.push({ categoryName: { in: filters.category } });
  }
  if (filters.tag.length > 0) and.push({ tags: { hasSome: filters.tag } });
  if (q !== "") {
    and.push({
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
    });
  }
  const where: Prisma.CatalogProductWhereInput = { shopId: shop.id, AND: and };

  const [total, products] = await Promise.all([
    prisma.catalogProduct.count({ where }),
    prisma.catalogProduct.findMany({
      where,
      orderBy: orderFor(query.sort),
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: {
        shopifyProductId: true,
        title: true,
        vendor: true,
        productType: true,
        categoryName: true,
        status: true,
        tags: true,
        imageUrl: true,
        shopifyUpdatedAt: true,
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
        categoryName: product.categoryName,
        status: product.status,
        tags: product.tags,
        imageUrl: product.imageUrl,
        variants: product.variants.length,
        sku:
          product.variants.length === 1
            ? (product.variants[0]?.sku ?? null)
            : null,
        minPriceMinor: prices.length > 0 ? Math.min(...prices) : null,
        maxPriceMinor: prices.length > 0 ? Math.max(...prices) : null,
        currency: product.variants[0]?.currency ?? null,
        updatedAt: product.shopifyUpdatedAt,
      };
    }),
  };
}

/** How many values of one facet the filter offers; the rest are searched. */
const FACET_OPTION_LIMIT = 500;

/**
 * The values each facet of the list can be filtered by, A to Z: every
 * vendor, product type, category and tag the snapshot holds.
 */
export async function catalogueFacetOptions(
  principal: Principal,
): Promise<ProductFilters> {
  const shopId = await shopIdFor(principal);
  const present = (values: ReadonlyArray<string | null>): string[] =>
    values.filter((value): value is string => !!value && value.trim() !== "");
  const [vendors, productTypes, categories, tagRows] = await Promise.all([
    prisma.catalogProduct.findMany({
      where: { shopId, vendor: { not: null } },
      distinct: ["vendor"],
      orderBy: { vendor: "asc" },
      select: { vendor: true },
      take: FACET_OPTION_LIMIT,
    }),
    prisma.catalogProduct.findMany({
      where: { shopId, productType: { not: null } },
      distinct: ["productType"],
      orderBy: { productType: "asc" },
      select: { productType: true },
      take: FACET_OPTION_LIMIT,
    }),
    prisma.catalogProduct.findMany({
      where: { shopId, categoryName: { not: null } },
      distinct: ["categoryName"],
      orderBy: { categoryName: "asc" },
      select: { categoryName: true },
      take: FACET_OPTION_LIMIT,
    }),
    prisma.$queryRaw<Array<{ tag: string }>>`
      SELECT DISTINCT unnest(tags) AS tag
      FROM catalog_product
      WHERE shop_id = ${shopId}
      ORDER BY tag
      LIMIT ${FACET_OPTION_LIMIT}
    `,
  ]);
  return {
    vendor: present(vendors.map((row) => row.vendor)),
    productType: present(productTypes.map((row) => row.productType)),
    category: present(categories.map((row) => row.categoryName)),
    tag: tagRows.map((row) => row.tag).filter((tag) => tag.trim() !== ""),
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
