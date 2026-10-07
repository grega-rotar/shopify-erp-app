import { prisma } from "~/adapters/db/client.server";
import { raiseException } from "~/adapters/db/repositories/exception.server";

import { ownerOf, seedConnectedShop } from "../support/seed";
import { expect, test } from "../support/test";

const LOCATION = "gid://shopify/Location/1";

/**
 * Needs attention: each row's actions are in view (docs/ui-conventions.md),
 * and pressing one closes that row and only that row.
 */
test("Resolve and Ignore close one exception each", async ({ page, shop }) => {
  await shop.resetServices({
    shopify: { locations: [{ id: LOCATION, name: "Glavno skladišče" }] },
  });
  await seedConnectedShop(shop, { locations: { [LOCATION]: "glavno" } });

  const owner = ownerOf(shop);
  await raiseException(owner, {
    kind: "stock_sync_failed",
    message: "Stock for Glavno skladišče could not be read from MetaKocka.",
    dedupeKey: "e2e:stock",
  });
  await raiseException(owner, {
    kind: "unmapped_payment_gateway",
    message:
      "Payment method “Bitcoin” is not mapped to a MetaKocka payment type.",
    dedupeKey: "e2e:gateway",
  });

  await page.goto("/app/exceptions");
  const stockRow = page.locator("s-table-row", {
    hasText: "could not be read from MetaKocka",
  });
  const gatewayRow = page.locator("s-table-row", {
    hasText: "is not mapped to a MetaKocka payment type",
  });
  await expect(stockRow).toBeVisible();
  await expect(gatewayRow).toBeVisible();

  await stockRow.getByRole("button", { name: "Resolve" }).click();
  await expect(page.getByText("Marked as resolved.")).toBeVisible();
  await expect(stockRow).toHaveCount(0);
  await expect(gatewayRow).toBeVisible();

  await gatewayRow.getByRole("button", { name: "Ignore" }).click();
  await expect(
    page.getByText("Ignored. It will not come back unless it happens again."),
  ).toBeVisible();
  await expect(gatewayRow).toHaveCount(0);

  const rows = await prisma.exception.findMany({
    where: { shopId: shop.id },
    select: { kind: true, status: true },
    orderBy: { kind: "asc" },
  });
  expect(rows).toEqual([
    { kind: "unmapped_payment_gateway", status: "ignored" },
    { kind: "stock_sync_failed", status: "resolved" },
  ]);
});
