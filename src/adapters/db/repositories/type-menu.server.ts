import { Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "~/adapters/db/client.server";
import {
  MENU_TYPE_FIELD,
  type CatalogueProductForMenu,
} from "~/domain/attributes/menu";
import { shopDomainOf, type Principal } from "~/domain/types";

/**
 * The store menu made from the product type tree (docs/attributes.md
 * § Store menu): what this app created in Shopify for it and the state of
 * the latest run, one row per shop; plus the reads the run needs.
 */

const collectionsCodec = z.record(
  z.string(),
  z.object({
    collectionId: z.string(),
    sourceId: z.string().nullable(),
    /** The title it was given; a type renamed since needs an update. */
    title: z.string().optional(),
  }),
);

export type TypeCollections = z.infer<typeof collectionsCodec>;

export type TypeMenuStatus = "running" | "done" | "failed";

export interface TypeMenuState {
  definitionId: string | null;
  menuId: string | null;
  collections: TypeCollections;
  status: TypeMenuStatus;
  phase: string | null;
  total: number;
  done: number;
  lastError: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

/**
 * A run that has not written progress for this long is taken to have died:
 * a live run writes after every hundred products and every collection, a
 * few seconds apart. It died with its worker (a deploy, a crash) or its job
 * never ran; either way nothing will ever finish it.
 */
export const TYPE_MENU_STALE_MS = 15 * 60 * 1000;
const STALE_MS = TYPE_MENU_STALE_MS;

const STALE_MESSAGE =
  "The menu stopped without finishing, most likely because the app restarted while it worked. What was already made is kept; press Update menu to finish it.";

async function shopIdOf(principal: Principal): Promise<string> {
  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomainOf(principal) },
    select: { id: true },
  });
  if (!shop) throw new Error(`Unknown shop ${shopDomainOf(principal)}`);
  return shop.id;
}

export async function getTypeMenu(
  principal: Principal,
): Promise<TypeMenuState | null> {
  // Close a run that died, so no page waits on it for ever.
  await prisma.productTypeMenu.updateMany({
    where: {
      shop: { domain: shopDomainOf(principal) },
      status: "running",
      updatedAt: { lt: new Date(Date.now() - STALE_MS) },
    },
    data: {
      status: "failed",
      lastError: STALE_MESSAGE,
      finishedAt: new Date(),
    },
  });
  const row = await prisma.productTypeMenu.findFirst({
    where: { shop: { domain: shopDomainOf(principal) } },
  });
  if (!row) return null;
  const collections = collectionsCodec.safeParse(row.collections);
  return {
    definitionId: row.definitionId,
    menuId: row.menuId,
    collections: collections.success ? collections.data : {},
    status:
      row.status === "running" || row.status === "failed" ? row.status : "done",
    phase: row.phase,
    total: row.total,
    done: row.done,
    lastError: row.lastError,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

/**
 * Marks a run as started. Refused while another run is moving, so two
 * presses make one menu; a run that stopped moving long ago no longer
 * blocks.
 */
export async function startTypeMenu(
  principal: Principal,
  requestedBy: string | null,
): Promise<{ started: boolean }> {
  const shopId = await shopIdOf(principal);
  const now = new Date();
  const fresh = {
    status: "running",
    phase: "products",
    total: 0,
    done: 0,
    lastError: null,
    requestedBy,
    startedAt: now,
    finishedAt: null,
  };
  const existing = await prisma.productTypeMenu.findUnique({
    where: { shopId },
    select: { status: true, updatedAt: true },
  });
  if (!existing) {
    try {
      await prisma.productTypeMenu.create({ data: { shopId, ...fresh } });
      return { started: true };
    } catch (error) {
      // Two first presses at once: the unique shop row lets one through.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      )
        return { started: false };
      throw error;
    }
  }
  const claimed = await prisma.productTypeMenu.updateMany({
    where: {
      shopId,
      OR: [
        { status: { not: "running" } },
        { updatedAt: { lt: new Date(now.getTime() - STALE_MS) } },
      ],
    },
    data: fresh,
  });
  return { started: claimed.count > 0 };
}

export async function updateTypeMenu(
  principal: Principal,
  patch: Partial<
    Pick<
      TypeMenuState,
      | "definitionId"
      | "menuId"
      | "collections"
      | "status"
      | "phase"
      | "total"
      | "done"
      | "lastError"
      | "finishedAt"
    >
  >,
): Promise<void> {
  await prisma.productTypeMenu.updateMany({
    where: { shop: { domain: shopDomainOf(principal) } },
    data: patch,
  });
}

/** Every type a person chose, by product. */
export async function chosenTypes(
  principal: Principal,
): Promise<Map<string, string>> {
  const rows = await prisma.productTypeAssignment.findMany({
    where: { shop: { domain: shopDomainOf(principal) } },
    select: { productId: true, typeId: true },
  });
  return new Map(rows.map((row) => [row.productId, row.typeId]));
}

const metafieldsCodec = z.record(
  z.string(),
  z.object({ value: z.string() }).passthrough(),
);

/** The catalogue as the menu needs it: what decides a type, and the field's value. */
export async function catalogueForMenu(
  principal: Principal,
): Promise<CatalogueProductForMenu[]> {
  const rows = await prisma.catalogProduct.findMany({
    where: { shop: { domain: shopDomainOf(principal) } },
    select: {
      shopifyProductId: true,
      productType: true,
      categoryName: true,
      metafields: true,
    },
    orderBy: { shopifyProductId: "asc" },
  });
  const field = `${MENU_TYPE_FIELD.namespace}.${MENU_TYPE_FIELD.key}`;
  return rows.map((row) => {
    const metafields = metafieldsCodec.safeParse(row.metafields ?? {});
    const raw = metafields.success ? metafields.data[field]?.value : undefined;
    return {
      productId: row.shopifyProductId,
      productType: row.productType,
      categoryName: row.categoryName,
      current: raw === undefined ? null : pathOfValue(raw),
    };
  });
}

/**
 * Keeps the catalogue's copy of the type field in step with what was just
 * written to Shopify, so the next run compares against the truth and writes
 * only what moved, not every product again until the next catalogue read.
 */
export async function recordTypeField(
  principal: Principal,
  changes: ReadonlyArray<{ productId: string; path: string[] | null }>,
): Promise<void> {
  if (changes.length === 0) return;
  const field = `${MENU_TYPE_FIELD.namespace}.${MENU_TYPE_FIELD.key}`;
  const rows = await prisma.catalogProduct.findMany({
    where: {
      shop: { domain: shopDomainOf(principal) },
      shopifyProductId: { in: changes.map((c) => c.productId) },
    },
    select: { id: true, shopifyProductId: true, metafields: true },
  });
  const wanted = new Map(changes.map((c) => [c.productId, c.path]));
  await prisma.$transaction(
    rows.map((row) => {
      const parsed = metafieldsCodec.safeParse(row.metafields ?? {});
      const metafields: Record<string, unknown> = parsed.success
        ? { ...parsed.data }
        : {};
      const path = wanted.get(row.shopifyProductId) ?? null;
      if (path === null) delete metafields[field];
      else
        metafields[field] = {
          type: MENU_TYPE_FIELD.type,
          value: JSON.stringify(path),
        };
      return prisma.catalogProduct.update({
        where: { id: row.id },
        data: { metafields: metafields as Prisma.InputJsonObject },
      });
    }),
  );
}

/** A list field's JSON value; anything unreadable counts as nothing there. */
function pathOfValue(raw: string): string[] | null {
  try {
    const parsed = z.array(z.string()).safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
