import { prisma } from "~/adapters/db/client.server";

import { expect, test } from "../support/test";

/**
 * Guided setup, start to finish, the way a merchant does it on a new install:
 * connect MetaKocka, connect a location to a warehouse, leave order transfer
 * off, finish. Finishing activates synchronization; the jobs it queues run on
 * the real worker against the fake services, and the fixture fails the test
 * if any of them fails.
 */
const LOCATION = "gid://shopify/Location/1";
test("a new shop goes through guided setup and activates", async ({
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
              inventory: { [LOCATION]: 0 },
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
          stock: { "678900000004": 7 },
        },
      ],
    },
  });

  await page.goto("/app");
  await expect(page.getByText("Step 1 of 5 · Welcome")).toBeVisible();
  await page.getByRole("button", { name: "Get started" }).click();

  await expect(page.getByText("Step 2 of 5")).toBeVisible();
  await page.getByLabel("Company ID").fill(shop.metakockaCompanyId);
  await page.getByLabel("Secret key").fill("e2e-secret");
  await page.getByLabel("API user email").fill("api@e2e.test");
  await page.getByRole("button", { name: "Connect" }).click();

  // The connection test read the company's warehouses, and the location is
  // offered the one with its name.
  await expect(page.getByText("Step 3 of 5")).toBeVisible();
  await expect(
    page.locator('input[name="warehouse:gid://shopify/Location/1"]'),
  ).toHaveValue("glavno");
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByText("Step 4 of 5")).toBeVisible();
  await page.getByLabel("Transfer orders to MetaKocka").uncheck();
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByText("Step 5 of 5")).toBeVisible();
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page).toHaveURL(/\/app(\?|$)/);

  const stored = await prisma.shop.findUniqueOrThrow({
    where: { id: shop.id },
    select: {
      setupCompletedAt: true,
      supplySources: {
        select: { shopifyLocationId: true, metakockaWarehouse: true },
      },
      metakockaPaymentTypes: { select: { value: true } },
    },
  });
  expect(stored.setupCompletedAt).not.toBeNull();
  expect(stored.supplySources).toContainEqual({
    shopifyLocationId: LOCATION,
    metakockaWarehouse: "glavno",
  });
  // Read from MetaKocka's rejection of the probe's payment type.
  expect(stored.metakockaPaymentTypes.map((type) => type.value).sort()).toEqual(
    ["Gotovina", "Kartica", "PayPal", "Predračun"],
  );

  // The catalogue pass matched the Shopify SKU to the MetaKocka article.
  await shop.settleJobs();
  const sku = await prisma.sku.findFirstOrThrow({
    where: { shopId: shop.id, sku: "WB-11" },
    select: { status: true },
  });
  expect(sku.status).toBe("matched");
});
