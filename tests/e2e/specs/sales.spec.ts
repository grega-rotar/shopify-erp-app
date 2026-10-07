import { createCampaign } from "~/adapters/db/repositories/sale-campaign.server";

import {
  ownerOf,
  seedCatalogueSnapshot,
  seedConnectedShop,
} from "../support/seed";
import { expect, test } from "../support/test";

const LOCATION = "gid://shopify/Location/1";

/**
 * A sale campaign's whole life in Shopify's prices (docs/sale-campaigns.md):
 * activating writes `price = sale, compareAtPrice = original`, and ending it
 * writes back both values it recorded.
 */
test("activating a sale writes sale prices, ending it restores them", async ({
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
          vendor: "E2E",
          variants: [
            {
              id: "gid://shopify/ProductVariant/1",
              title: "Črna",
              sku: "WB-11-B",
              price: "100.00",
              compareAtPrice: null,
            },
            {
              id: "gid://shopify/ProductVariant/2",
              title: "Bela",
              sku: "WB-11-W",
              price: "50.00",
              compareAtPrice: null,
            },
          ],
        },
      ],
    },
  });
  await seedConnectedShop(shop, { locations: { [LOCATION]: "glavno" } });
  await seedCatalogueSnapshot(shop);

  const campaign = await createCampaign(
    ownerOf(shop),
    {
      name: "Jesenska razprodaja",
      currency: "EUR",
      discountType: "percentage",
      discountValue: 2000,
      includeRules: {
        kind: "group",
        op: "and",
        rules: [{ kind: "rule", field: "all_products", operator: "is_true" }],
      },
    },
    "owner@e2e.test",
  );

  await page.goto(`/app/sales/${campaign.id}`);
  // The sidebar's button; it stays disabled while the preview loads.
  const activate = page.locator("s-button:not([slot])", {
    hasText: "Activate campaign",
  });
  await expect(activate).not.toHaveAttribute("disabled");
  await activate.click();
  await page
    .locator("s-modal#confirm-activate")
    .getByRole("button", { name: "Activate" })
    .click();
  await expect(
    page.locator("s-badge", { hasText: "Active" }).first(),
  ).toBeVisible();

  await shop.settleJobs();
  const prices = async () =>
    (await shop.services()).shopify.products[0]!.variants.map((variant) => ({
      price: variant.price,
      compareAtPrice: variant.compareAtPrice,
    }));
  expect(await prices()).toEqual([
    { price: "80.00", compareAtPrice: "100.00" },
    { price: "40.00", compareAtPrice: "50.00" },
  ]);

  await page.reload();
  // A page-header action: the admin shows it in its title bar, which does not
  // exist outside the admin, so the button is pressed without being seen.
  const end = page.locator('s-button[slot="primary-action"]', {
    hasText: "End now",
  });
  await expect(end).not.toHaveAttribute("disabled");
  await end.dispatchEvent("click");
  await page
    .locator("s-modal#confirm-end")
    .getByRole("button", { name: "End campaign" })
    .click();
  await expect(
    page.locator("s-badge", { hasText: /Ending|Completed/ }).first(),
  ).toBeVisible();

  await shop.settleJobs();
  expect(await prices()).toEqual([
    { price: "100.00", compareAtPrice: null },
    { price: "50.00", compareAtPrice: null },
  ]);
});
