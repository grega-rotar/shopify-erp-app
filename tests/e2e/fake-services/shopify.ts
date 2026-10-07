import { z } from "zod";

import { shopState, type ShopifyStore } from "./state";

/**
 * Fake Admin GraphQL, dispatched on the operation name.
 *
 * Every query in src/adapters/shopify is named, and the name is the contract
 * here: a handler gets the shop's store and the variables and returns `data`.
 * An operation with no handler is recorded and answered with an error, which
 * the e2e Shopify module throws like the real client does.
 */

type Variables = Record<string, unknown>;
type Handler = (store: ShopifyStore, variables: Variables) => unknown;

const EMPTY_PAGE = { hasNextPage: false, endCursor: null };

/** Every variant with its product, the way most catalogue queries see them. */
function variantsOf(store: ShopifyStore) {
  return store.products.flatMap((product) =>
    product.variants.map((variant) => ({ product, variant })),
  );
}

/** `gid://shopify/ProductVariant/7` -> `gid://shopify/InventoryItem/7`. */
function inventoryItemId(variantId: string): string {
  return variantId.replace("/ProductVariant/", "/InventoryItem/");
}

const setQuantitiesSchema = z.object({
  input: z.object({
    name: z.literal("on_hand"),
    quantities: z.array(
      z.object({
        inventoryItemId: z.string(),
        locationId: z.string(),
        quantity: z.number().int(),
        changeFromQuantity: z.number().int().nullable().optional(),
      }),
    ),
  }),
});

const writeVariantPricesSchema = z.object({
  productId: z.string(),
  variants: z.array(
    z.object({
      id: z.string(),
      price: z.string(),
      compareAtPrice: z.string().nullable(),
    }),
  ),
});

const MARKET = {
  id: "gid://shopify/Market/1",
  name: "Slovenia",
  handle: "si",
  status: "ACTIVE",
};

/** One web presence, the store's own domain, carrying every locale. */
function webPresence(store: ShopifyStore) {
  const primary =
    store.locales.find((locale) => locale.primary) ?? store.locales[0];
  return {
    id: "gid://shopify/MarketWebPresence/1",
    defaultLocale: { locale: primary?.locale ?? "en" },
    alternateLocales: store.locales
      .filter((locale) => locale !== primary)
      .map((locale) => ({ locale: locale.locale })),
    domain: { host: "e2e-store.example" },
    subfolderSuffix: null,
  };
}

/** What Shopify offers in the Add language picker; enough for a picker. */
const AVAILABLE_LOCALES = [
  { isoCode: "de", name: "German" },
  { isoCode: "en", name: "English" },
  { isoCode: "hr", name: "Croatian" },
  { isoCode: "it", name: "Italian" },
  { isoCode: "sl", name: "Slovenian" },
];

const handlers: Record<string, Handler> = {
  OrchestratorLocations: (store) => ({
    locations: {
      nodes: store.locations.map((location) => ({
        id: location.id,
        name: location.name,
        isActive: location.isActive,
        fulfillmentService: null,
        address: { city: "Ljubljana", country: "Slovenia" },
      })),
    },
  }),

  // No orders in the fake store yet, so no gateway has been used.
  OrchestratorPaymentGateways: () => ({ orders: { nodes: [] } }),
  OrchestratorOrdersSince: () => ({
    orders: { pageInfo: EMPTY_PAGE, nodes: [] },
  }),

  OrchestratorOnHand: (store, variables) => {
    const locationId = String(variables.locationId);
    if (!store.locations.some((location) => location.id === locationId)) {
      return { location: null };
    }
    return {
      location: {
        inventoryLevels: {
          pageInfo: EMPTY_PAGE,
          nodes: variantsOf(store).flatMap(({ variant }) => {
            const quantity = variant.inventory[locationId];
            return quantity === undefined
              ? []
              : [
                  {
                    item: { id: inventoryItemId(variant.id) },
                    quantities: [{ name: "on_hand", quantity }],
                  },
                ];
          }),
        },
      },
    };
  },

  // Compare-and-set like Shopify: a stale `changeFromQuantity` is a user error
  // and nothing in the batch is written.
  OrchestratorSetOnHand: (store, variables) => {
    const { input } = setQuantitiesSchema.parse(variables);
    const byItem = new Map(
      variantsOf(store).map(({ variant }) => [
        inventoryItemId(variant.id),
        variant,
      ]),
    );
    const userErrors = input.quantities.flatMap((write) => {
      const variant = byItem.get(write.inventoryItemId);
      if (!variant)
        return [
          {
            field: ["input"],
            message: `Unknown item ${write.inventoryItemId}`,
          },
        ];
      const current = variant.inventory[write.locationId] ?? 0;
      return write.changeFromQuantity != null &&
        write.changeFromQuantity !== current
        ? [{ field: ["input"], message: "The compare quantity is stale." }]
        : [];
    });
    if (userErrors.length === 0) {
      for (const write of input.quantities) {
        byItem.get(write.inventoryItemId)!.inventory[write.locationId] =
          write.quantity;
      }
    }
    return {
      inventorySetQuantities: {
        userErrors,
        inventoryAdjustmentGroup: userErrors.length
          ? null
          : { createdAt: new Date().toISOString(), reason: "correction" },
      },
    };
  },

  OrchestratorShopLocales: (store) => ({
    shopLocales: store.locales.map((locale) => ({
      ...locale,
      marketWebPresences: [
        { ...webPresence(store), markets: { nodes: [MARKET] } },
      ],
    })),
  }),

  OrchestratorMarkets: (store) => ({
    markets: {
      nodes: [{ ...MARKET, webPresences: { nodes: [webPresence(store)] } }],
    },
  }),

  OrchestratorAvailableLocales: () => ({ availableLocales: AVAILABLE_LOCALES }),

  OrchestratorVariantCount: (store) => ({
    productVariantsCount: {
      count: variantsOf(store).length,
      precision: "EXACT",
    },
  }),

  // Without metafields or the variant count: the fake store has neither.
  OrchestratorVariantDetails: (store) => ({
    productVariants: {
      pageInfo: EMPTY_PAGE,
      nodes: variantsOf(store).map(({ product, variant }) => ({
        id: variant.id,
        sku: variant.sku,
        title: variant.title,
        barcode: null,
        price: variant.price,
        selectedOptions: [{ name: "Title", value: variant.title }],
        product: {
          id: product.id,
          title: product.title,
          vendor: product.vendor,
          productType: product.productType,
          handle: product.handle,
        },
      })),
    },
  }),

  OrchestratorMetafieldDefinitions: () => ({
    productDefs: { nodes: [] },
    variantDefs: { nodes: [] },
  }),

  // The fake does not evaluate Shopify search syntax; nothing is waiting for
  // review in a fake store until a spec needs otherwise.
  OrchestratorReviewCount: () => ({ productsCount: { count: 0 } }),
  OrchestratorReviewProducts: () => ({
    products: {
      pageInfo: {
        hasNextPage: false,
        hasPreviousPage: false,
        startCursor: null,
        endCursor: null,
      },
      nodes: [],
    },
    productsCount: { count: 0, precision: "EXACT" },
  }),

  OrchestratorVariantPrices: (store, variables) => {
    const ids = z.array(z.string()).parse(variables.ids);
    const byId = new Map(
      variantsOf(store).map((entry) => [entry.variant.id, entry]),
    );
    return {
      nodes: ids.map((id) => {
        const entry = byId.get(id);
        if (!entry) return null;
        const { product, variant } = entry;
        return {
          id: variant.id,
          sku: variant.sku,
          title: variant.title,
          price: variant.price,
          compareAtPrice: variant.compareAtPrice,
          product: { id: product.id, title: product.title },
        };
      }),
    };
  },

  OrchestratorWriteVariantPrices: (store, variables) => {
    const input = writeVariantPricesSchema.parse(variables);
    const product = store.products.find(
      (entry) => entry.id === input.productId,
    );
    if (!product) {
      return {
        productVariantsBulkUpdate: {
          productVariants: null,
          userErrors: [
            {
              field: ["productId"],
              message: "Product does not exist",
              code: "PRODUCT_DOES_NOT_EXIST",
            },
          ],
        },
      };
    }
    const written = input.variants.flatMap((write) => {
      const variant = product.variants.find((entry) => entry.id === write.id);
      if (!variant) return [];
      variant.price = write.price;
      variant.compareAtPrice = write.compareAtPrice;
      return [
        {
          id: variant.id,
          price: variant.price,
          compareAtPrice: variant.compareAtPrice,
        },
      ];
    });
    return {
      productVariantsBulkUpdate: { productVariants: written, userErrors: [] },
    };
  },

  // No automatic discounts and no Markets price lists in the fake store, so
  // the sale preview has nothing to warn about.
  OrchestratorAutomaticDiscounts: () => ({ discountNodes: { nodes: [] } }),
  OrchestratorPriceLists: () => ({
    priceLists: { pageInfo: EMPTY_PAGE, nodes: [] },
  }),

  OrchestratorTaxSettings: (store) => ({
    shop: {
      taxesIncluded: store.taxesIncluded,
      currencyCode: store.currencyCode,
    },
  }),

  OrchestratorVariants: (store) => ({
    productVariants: {
      pageInfo: EMPTY_PAGE,
      nodes: variantsOf(store).map(({ product, variant }) => ({
        id: variant.id,
        sku: variant.sku,
        title: variant.title,
        displayName: `${product.title} - ${variant.title}`,
        price: variant.price,
        inventoryItem: { id: inventoryItemId(variant.id) },
        image: null,
        product: {
          id: product.id,
          title: product.title,
          vendor: product.vendor,
          productType: product.productType,
          featuredImage: null,
        },
      })),
    },
  }),
};

const requestSchema = z.object({
  shop: z.string(),
  query: z.string(),
  variables: z.record(z.string(), z.unknown()).default({}),
});

export function operationName(query: string): string {
  return (
    /\b(?:query|mutation)\s+([A-Za-z0-9_]+)/.exec(query)?.[1] ?? "anonymous"
  );
}

export function handleShopifyGraphql(body: unknown): unknown {
  const request = requestSchema.parse(body);
  const operation = operationName(request.query);
  const state = shopState(request.shop);

  if (!state) {
    return {
      errors: [
        {
          message: `fake shopify: shop ${request.shop} was never reset by a spec`,
        },
      ],
    };
  }

  const handler = handlers[operation];
  state.calls.push({
    service: "shopify",
    operation,
    variables: request.variables,
    handled: handler !== undefined,
  });

  if (!handler) {
    return {
      errors: [{ message: `fake shopify: no handler for ${operation}` }],
    };
  }
  return { data: handler(state.shopify, request.variables) };
}
