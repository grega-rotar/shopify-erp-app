import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import { getAttributeSchema } from "~/adapters/db/repositories/attribute-schema.server";
import { assignedTypeFor } from "~/adapters/db/repositories/product-type-assignment.server";
import { getCatalogueState } from "~/adapters/db/repositories/catalogue.server";
import { getProductSyncSetting } from "~/adapters/db/repositories/product-sync-setting.server";
import {
  lastCatalogueRead,
  registryFor,
  saleRowsForProduct,
  trailForProduct,
  translationWorkFor,
  type SaleRow,
} from "~/adapters/db/repositories/product-workspace.server";
import {
  listLanguageSettings,
  listOwnership,
} from "~/adapters/db/repositories/translations.server";
import { listShopLocales } from "~/adapters/shopify/locales";
import {
  readVariantInventory,
  readWorkspaceProduct,
  VARIANT_LIMIT,
  type WorkspaceProduct,
} from "~/adapters/shopify/product-workspace";
import { readTranslatableResourcesByIds } from "~/adapters/shopify/translations";
import { hashValue } from "~/adapters/translations/engine.server";
import { getLogger } from "~/adapters/observability/logger.server";
import {
  assignableTypes,
  type AssignableType,
  type AttributeField,
  type AttributeInputs,
} from "~/domain/products/attribute-values";
import {
  isAwaitingReview,
  sourceIdFromTags,
} from "~/domain/export-portal/review";
import {
  attributeCompleteness,
  isProtectedTag,
  localeStatuses,
  productIssues,
  stockWriterFor,
  typeForProduct,
  type AttributeCompleteness,
  type ProductFields,
  type StockWriter,
} from "~/domain/products/workspace";
import { isTranslatableField } from "~/domain/translations/plan";
import { fieldLabel, keptKeys } from "~/domain/translations/types";
import type { Principal } from "~/domain/types";
import { loadLocationRows } from "~/web/lib/locations.server";
import { readAttributeValues } from "~/web/lib/product-attributes.server";
import { describeProductTrail } from "~/web/lib/product-workspace";
import { readPortal } from "~/web/lib/sources.server";

/**
 * Everything the product workspace shows about one product, read in one
 * pass (docs/architecture.md § Product workspace).
 *
 * The product itself is read live from Shopify, because the page edits it.
 * Everything this app owns — the SKU registry, sale rows, the plan, the
 * trail, language settings, translation ownership — comes from our tables.
 * Nothing waits on MetaKocka. The reads that do not depend on one another
 * run side by side, and every read past the product itself fails soft: a
 * section that could not be read says so, and the rest of the page stands.
 */

/** What the page says about the product setup plan for this product. */
export type SetupView =
  | { kind: "unavailable"; message: string }
  | { kind: "no_plan" }
  | { kind: "none"; types: AssignableType[] }
  | { kind: "ambiguous"; candidates: string[]; types: AssignableType[] }
  | {
      kind: "matched";
      path: string[];
      typeId: string;
      /** Chosen by a person, or matched by category or product type. */
      via: "chosen" | "category" | "product_type";
      types: AssignableType[];
      completeness: AttributeCompleteness;
      /** The values as the editor enters them. */
      fields: AttributeField[];
      inputs: AttributeInputs;
      variantDetailsRead: boolean;
    };

export function productGid(param: string): string {
  return param.startsWith("gid://") ? param : `gid://shopify/Product/${param}`;
}

/** A section's read, or why it has nothing. */
export type Part<T> = { ok: true; data: T } | { ok: false; message: string };

async function part<T>(
  label: string,
  read: () => Promise<T>,
): Promise<Part<T>> {
  try {
    return { ok: true, data: await read() };
  } catch (error) {
    getLogger().warn(
      { err: error, part: label },
      "Product workspace read failed",
    );
    return {
      ok: false,
      message: `The ${label} could not be read just now. Reload to try again.`,
    };
  }
}

export function savedFields(product: WorkspaceProduct): ProductFields {
  return {
    title: product.title,
    descriptionHtml: product.descriptionHtml,
    vendor: product.vendor,
    productType: product.productType,
    status: product.status,
    tags: product.tags,
    seoTitle: product.seoTitle,
    seoDescription: product.seoDescription,
  };
}

function saleSummary(rows: readonly SaleRow[]) {
  const byCampaign = new Map<
    string,
    { campaign: SaleRow["campaign"]; rows: SaleRow[] }
  >();
  for (const row of rows) {
    const entry = byCampaign.get(row.campaign.id) ?? {
      campaign: row.campaign,
      rows: [],
    };
    entry.rows.push(row);
    byCampaign.set(row.campaign.id, entry);
  }
  return [...byCampaign.values()].map(({ campaign, rows: held }) => ({
    id: campaign.id,
    name: campaign.name,
    status: campaign.status,
    discount: { type: campaign.discountType, value: campaign.discountValue },
    currency: held[0]?.currency ?? "",
    startsAt: campaign.startsAt?.toISOString() ?? null,
    endsAt: campaign.endsAt?.toISOString() ?? null,
    variants: held.length,
    onSale: held.filter((row) => row.state === "applied").length,
    decisions: held.filter((row) => row.state === "review").length,
    problems: held.filter((row) => row.state === "restore_failed").length,
  }));
}

export async function loadProductWorkspace(
  admin: AdminApiContext,
  principal: Principal,
  productId: string,
) {
  const product = await readWorkspaceProduct(admin, productId);
  if (!product) return null;

  const variantIds = product.variants.map((variant) => variant.variantId);
  const skus = product.variants.flatMap((variant) =>
    variant.sku ? [variant.sku] : [],
  );
  const sourceId = sourceIdFromTags(product.tags);

  const [
    catalogue,
    schema,
    registry,
    saleRows,
    productSync,
    lastRead,
    trail,
    aiWork,
    inventory,
    locations,
    translations,
    source,
  ] = await Promise.all([
    getCatalogueState(principal),
    part("product setup", async () => {
      const [stored, chosenTypeId] = await Promise.all([
        getAttributeSchema(principal),
        assignedTypeFor(principal, productId),
      ]);
      return { ...stored, chosenTypeId };
    }),
    registryFor(principal, skus),
    saleRowsForProduct(principal, productId),
    getProductSyncSetting(principal),
    lastCatalogueRead(principal),
    trailForProduct(principal, productId, variantIds, 40),
    translationWorkFor(principal, productId, 20),
    part("stock levels", () => readVariantInventory(admin, variantIds)),
    part("locations", () => loadLocationRows(admin, principal)),
    part("translations", async () => {
      const [locales, languages, ownership] = await Promise.all([
        listShopLocales(admin),
        listLanguageSettings(principal),
        listOwnership(principal, [productId]),
      ]);
      if (locales.kind !== "read") throw new Error(locales.reason);
      const targets = locales.locales.filter((locale) => !locale.primary);
      const [resource] = await readTranslatableResourcesByIds(admin, {
        ids: [productId],
        locales: targets.map((locale) => locale.locale),
      });
      return {
        locales: locales.locales,
        targets,
        languages,
        ownership,
        resource,
      };
    }),
    sourceId
      ? readPortal(principal, (client) => client.getSource(sourceId))
      : Promise.resolve(null),
  ]);

  /* ---------------------------- Product setup ---------------------------- */

  const setup = (() => {
    if (!schema.ok)
      return { kind: "unavailable" as const, message: schema.message };
    const plan = schema.data.schema;
    if (plan.types.length === 0) return { kind: "no_plan" as const };
    const types = assignableTypes(plan);
    const match = typeForProduct(plan, {
      categoryName: product.category?.name ?? null,
      categoryFullName: product.category?.fullName ?? null,
      productType: product.productType,
      chosenTypeId: schema.data.chosenTypeId,
    });
    if (match.kind !== "matched")
      return {
        kind: match.kind,
        types,
        candidates:
          match.kind === "ambiguous"
            ? match.typeIds.map(
                (id) => plan.types.find((t) => t.id === id)?.name ?? id,
              )
            : [],
      };
    return { kind: "matched" as const, match, plan, types };
  })();

  const values =
    setup.kind === "matched"
      ? await part("product details", () =>
          readAttributeValues(admin, setup.plan, setup.match.typeId, product),
        )
      : null;

  const setupView: SetupView =
    setup.kind === "matched"
      ? values?.ok
        ? {
            kind: "matched",
            path: setup.match.path,
            typeId: setup.match.typeId,
            via: setup.match.via,
            types: setup.types,
            completeness: attributeCompleteness(
              setup.plan,
              setup.match.typeId,
              product.metafields,
              values.data.variantMetafields,
            ),
            fields: values.data.fields,
            inputs: values.data.inputs,
            variantDetailsRead: values.data.variantDetailsRead,
          }
        : {
            kind: "unavailable",
            message:
              values?.message ??
              "The product details could not be read just now.",
          }
      : setup.kind === "ambiguous"
        ? {
            kind: "ambiguous",
            candidates: setup.candidates,
            types: setup.types,
          }
        : setup.kind === "none"
          ? { kind: "none", types: setup.types }
          : setup;

  /* ------------------------------ Variants ------------------------------- */

  const saleByVariant = new Map(saleRows.map((row) => [row.variantId, row]));
  const LIVE = new Set([
    "applying",
    "applied",
    "review",
    "restoring",
    "restore_failed",
  ]);
  const variants = product.variants.map((variant) => {
    const match = variant.sku ? (registry.get(variant.sku) ?? null) : null;
    const sale = saleByVariant.get(variant.variantId) ?? null;
    return {
      ...variant,
      match: match
        ? {
            status: match.status,
            metakockaName: match.metakockaName,
            metakockaCode: match.metakockaCode,
          }
        : null,
      sale: sale
        ? {
            campaignId: sale.campaign.id,
            campaignName: sale.campaign.name,
            state: sale.state,
            held: LIVE.has(sale.state),
            salePriceMinor: sale.salePriceMinor,
            originalPriceMinor: sale.originalPriceMinor,
            originalCompareAtMinor: sale.originalCompareAtMinor,
            endsAt: sale.campaign.endsAt?.toISOString() ?? null,
          }
        : null,
    };
  });

  /* ------------------------------ Inventory ------------------------------ */

  const stock = (() => {
    if (!inventory.ok)
      return { ok: false as const, message: inventory.message };
    const rows = locations.ok ? locations.data.locations : [];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const locationIds = new Set<string>();
    for (const item of inventory.data.values())
      for (const level of item.levels) locationIds.add(level.locationId);
    const names = new Map<string, string>();
    for (const item of inventory.data.values())
      for (const level of item.levels)
        names.set(level.locationId, level.locationName);
    return {
      ok: true as const,
      locationsRead: locations.ok,
      locations: [...locationIds].map((id) => {
        const row = byId.get(id);
        const writer: StockWriter = stockWriterFor(
          { fulfillmentServiceName: row?.fulfillmentServiceName ?? null },
          row && row.sourceId
            ? {
                stockDirection: row.direction,
                enabled: row.status !== "paused",
                warehouseName: row.warehouseName,
              }
            : null,
        );
        return {
          id,
          name: row?.name ?? names.get(id) ?? "Location",
          writer,
          syncMessage: row?.syncMessage ?? null,
        };
      }),
      rows: product.variants.map((variant) => {
        const item = inventory.data.get(variant.variantId);
        return {
          variantId: variant.variantId,
          title: variant.title,
          sku: variant.sku,
          tracked: item?.tracked ?? false,
          levels: Object.fromEntries(
            (item?.levels ?? []).map((level) => [
              level.locationId,
              { available: level.available, onHand: level.onHand },
            ]),
          ),
        };
      }),
    };
  })();

  /* ---------------------------- Translations ----------------------------- */

  const translationView = (() => {
    if (!translations.ok)
      return { ok: false as const, message: translations.message };
    const { locales, targets, languages, ownership, resource } =
      translations.data;
    const primary = locales.find((locale) => locale.primary) ?? null;
    const settings = new Map(
      languages.map((language) => [language.locale, language]),
    );
    const kept = (locale: string) =>
      keptKeys(settings.get(locale)?.keepOriginal ?? [], "PRODUCT");
    if (!resource || !primary)
      return {
        ok: false as const,
        message: "Shopify reports nothing to translate on this product.",
      };
    const records = ownership.get(productId) ?? [];
    const statuses = localeStatuses({
      fields: resource.fields,
      translations: resource.translations,
      ownership: records,
      locales: targets.map((locale) => locale.locale),
      kept,
      hash: hashValue,
    });
    const statusByLocale = new Map(
      statuses.map((status) => [status.locale, status]),
    );
    return {
      ok: true as const,
      primary: { locale: primary.locale, name: primary.name },
      languages: targets.map((locale) => {
        const setting = settings.get(locale.locale) ?? null;
        const status = statusByLocale.get(locale.locale);
        const existing = new Map(
          (resource.translations.get(locale.locale) ?? []).map((t) => [
            t.key,
            t,
          ]),
        );
        return {
          locale: locale.locale,
          name: locale.name,
          published: locale.published,
          aiEnabled: setting?.aiEnabled ?? false,
          owed: status?.owed ?? 0,
          missing: status?.missing ?? 0,
          outdated: status?.outdated ?? 0,
          percent: status?.percent ?? 100,
          fields: Object.fromEntries(
            (status?.fields ?? []).map((field) => [
              field.key,
              {
                state: field.state,
                value: existing.get(field.key)?.value ?? "",
              },
            ]),
          ),
        };
      }),
      /** The fields a person translates, in Shopify's order, with their sources. */
      fields: resource.fields
        .filter((field) => field.digest !== null && isTranslatableField(field))
        .map((field) => ({
          key: field.key,
          label: fieldLabel(field.key),
          type: field.type,
          source: field.value,
          digest: field.digest ?? "",
        })),
    };
  })();

  /* ------------------------------- Source -------------------------------- */

  const awaitingReview = isAwaitingReview({
    status: product.status,
    tags: product.tags,
  });
  const sourceView = sourceId
    ? source && source.kind === "read"
      ? {
          id: sourceId,
          name: source.data.name,
          kind: source.data.kindLabel,
          health: source.data.health,
          lastRunAt:
            source.data.lastRun?.finishedAt ??
            source.data.lastRun?.startedAt ??
            null,
          read: true as const,
        }
      : {
          id: sourceId,
          name: null,
          kind: null,
          health: null,
          lastRunAt: null,
          read: false as const,
          message: source && "message" in source ? source.message : null,
        }
    : null;

  /* ------------------------------ Issues --------------------------------- */

  const sales = saleSummary(saleRows);
  const issues = productIssues({
    missingRequired:
      setupView.kind === "matched"
        ? setupView.completeness.missingRequired
        : [],
    variantsWithoutSku: product.variants.filter((variant) => !variant.sku)
      .length,
    unmatchedVariants: variants.filter(
      (variant) => variant.match?.status === "unmatched",
    ).length,
    locales: translationView.ok
      ? translationView.languages
          .filter((language) => language.published)
          .map((language) => ({
            name: language.name,
            missing: language.missing,
            outdated: language.outdated,
          }))
      : [],
    saleDecisions: sales
      .filter((sale) => sale.decisions > 0)
      .map((sale) => ({
        campaignId: sale.id,
        campaignName: sale.name,
        count: sale.decisions,
      })),
    awaitingReview,
  });

  /* ------------------------------ Activity ------------------------------- */

  const languageName = new Map(
    translations.ok
      ? translations.data.locales.map((l) => [l.locale, l.name])
      : [],
  );
  const variantTitle = new Map(
    product.variants.map((v) => [v.variantId, v.title]),
  );
  const activity = describeProductTrail({
    trail: trail.map((entry) => ({ ...entry, at: entry.at.toISOString() })),
    aiWork: aiWork.map((item) => ({ ...item, at: item.at.toISOString() })),
    languageName: (locale) => languageName.get(locale) ?? locale,
    variantTitle: (id) => variantTitle.get(id) ?? null,
    singleVariant: product.hasOnlyDefaultVariant,
  });

  const currency = catalogue.currencyCode ?? saleRows[0]?.currency ?? "EUR";

  return {
    product: {
      id: product.productId,
      legacyId: product.legacyId,
      title: product.title,
      handle: product.handle,
      vendor: product.vendor,
      productType: product.productType,
      status: product.status,
      category: product.category,
      collections: product.collections,
      onlineStoreUrl: product.onlineStoreUrl,
      previewUrl: product.onlineStorePreviewUrl,
      updatedAt: product.updatedAt,
      hasOnlyDefaultVariant: product.hasOnlyDefaultVariant,
      options: product.options,
      variantsCount: product.variantsCount,
      variantsShown: product.variants.length,
      variantLimit: VARIANT_LIMIT,
      protectedTags: product.tags.filter(isProtectedTag),
      imageUrl:
        product.media.find((m) => m.featured)?.url ??
        product.media[0]?.url ??
        null,
    },
    fields: savedFields(product),
    media: { items: product.media, count: product.mediaCount },
    currency,
    timeZone: catalogue.ianaTimezone,
    variants,
    stock,
    setup: setupView,
    translations: translationView,
    metakocka: {
      lastReadAt: lastRead?.toISOString() ?? null,
      nameSync: productSync.enabled,
      namePolicy: productSync.namePolicy,
      pricing: productSync.enabled && productSync.updatePricing,
      scheduled: productSync.scheduleEnabled,
    },
    source: sourceView,
    awaitingReview,
    sales,
    issues,
    activity,
  };
}

export type ProductWorkspace = NonNullable<
  Awaited<ReturnType<typeof loadProductWorkspace>>
>;
