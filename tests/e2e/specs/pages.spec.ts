import { seedConnectedShop } from "../support/seed";
import { expect, test } from "../support/test";

/**
 * Every page without a parameter in its path, opened as a shop that finished
 * setup. Catches a loader that throws, a page that crashes in the browser, and
 * a page that starts asking Shopify or MetaKocka something the fakes do not
 * answer — the fixture fails on the last two.
 *
 * A new route under /app belongs here.
 */
const PAGES = [
  "/app",
  "/app/exceptions",
  "/app/locations",
  "/app/locations/settings",
  "/app/metakocka",
  "/app/metakocka/locations",
  "/app/metakocka/locations/settings",
  "/app/metakocka/products",
  "/app/metakocka/products/sync",
  "/app/orders",
  "/app/orders/settings",
  "/app/orders/settings/payments",
  "/app/products",
  "/app/products/sync",
  "/app/product-setup",
  "/app/product-setup/attributes",
  "/app/product-setup/menu",
  "/app/product-setup/sets",
  "/app/product-setup/settings",
  "/app/sales",
  "/app/settings",
  "/app/settings/metakocka",
  "/app/settings/payments",
  "/app/settings/sales-orders",
  "/app/settings/supply-sources",
  "/app/settings/taxes",
  "/app/settings/taxes/mappings",
  "/app/settings/taxes/overrides",
  "/app/settings/taxes/rates",
  "/app/settings/taxes/registrations",
  "/app/setup",
  "/app/sources",
  "/app/sources/categorization",
  "/app/sources/connection",
  "/app/sources/new",
  "/app/sources/review",
  "/app/translations",
  "/app/translations/add",
  "/app/translations/context",
  "/app/translations/editor",
  "/app/translations/glossary",
  "/app/translations/syncs",
  "/app/translations/translate",
  "/app/translations/usage",
];

const LOCATION = "gid://shopify/Location/1";

for (const path of PAGES) {
  test(`${path} renders`, async ({ page, shop }) => {
    await shop.resetServices({
      shopify: { locations: [{ id: LOCATION, name: "Glavno skladišče" }] },
    });
    await seedConnectedShop(shop, { locations: { [LOCATION]: "glavno" } });

    const response = await page.goto(path);
    expect(
      response?.status(),
      `${path} answered with an error status`,
    ).toBeLessThan(400);
    await expect(page.locator("s-page").first()).toBeAttached();
  });
}
