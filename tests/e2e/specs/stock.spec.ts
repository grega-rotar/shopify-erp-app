import { seedConnectedShop } from "../support/seed";
import { expect, test } from "../support/test";

const LOCATION = "gid://shopify/Location/1";
const GLAVNO = "678900000004";

/**
 * MetaKocka counts stock, Shopify shows it: pressing "Sync stock now" queues
 * the inventory job, and the worker writes MetaKocka's amount as Shopify's on
 * hand at the mapped location (docs/BUILD_SPEC.md section 7).
 */
test("Sync stock now publishes MetaKocka stock to Shopify", async ({
  page,
  shop,
}) => {
  await shop.resetServices({
    shopify: {
      locations: [{ id: LOCATION, name: "Glavno skladišče" }],
      products: [
        {
          id: "gid://shopify/Product/1",
          title: "Polnilnica 11 kW",
          handle: "polnilnica-11-kw",
          variants: [
            {
              id: "gid://shopify/ProductVariant/1",
              title: "Default Title",
              sku: "WB-11",
              price: "899.00",
              compareAtPrice: null,
              inventory: { [LOCATION]: 2 },
            },
          ],
        },
      ],
    },
    metakocka: {
      products: [
        {
          mkId: "1001",
          code: "WB-11",
          name: "Polnilnica 11 kW",
          stock: { [GLAVNO]: 7 },
        },
      ],
    },
  });
  await seedConnectedShop(shop, {
    locations: { [LOCATION]: "glavno" },
    direction: "mk_to_shopify",
    matchCatalogue: true,
  });

  await page.goto("/app/metakocka/locations");
  await page.getByRole("button", { name: "Sync stock now" }).click();
  await expect(page.getByText("Syncing stock in the background")).toBeVisible();

  await shop.settleJobs();
  const { shopify } = await shop.services();
  expect(shopify.products[0]?.variants[0]?.inventory[LOCATION]).toBe(7);
});
