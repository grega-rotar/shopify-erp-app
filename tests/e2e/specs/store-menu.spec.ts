import {
  startTypeMenu,
  updateTypeMenu,
} from "~/adapters/db/repositories/type-menu.server";

import { ownerOf, seedConnectedShop } from "../support/seed";
import { expect, test } from "../support/test";

/**
 * The store menu page follows a run without a reload (docs/attributes.md
 * § Store menu): while a run is going it re-reads, and the moment the run
 * ends it shows the result — even when one of those reads never answers.
 */
test("the store menu page shows a finished run without a reload", async ({
  page,
  shop,
}) => {
  await seedConnectedShop(shop, { locations: {} });
  const owner = ownerOf(shop);
  await startTypeMenu(owner, null);

  await page.goto("/app/product-setup/menu");
  const banner = page.getByText("Making the menu", { exact: true });
  await expect(banner.first()).toBeVisible();

  // The first re-read hangs, as a request to a slow or dropped connection
  // can; the page must not wait on it for ever.
  let stalled = false;
  await page.route("**/product-setup/menu.data*", async (route) => {
    if (!stalled) {
      stalled = true;
      return; // never answered
    }
    await route.continue();
  });
  await expect.poll(() => stalled, { timeout: 10_000 }).toBe(true);

  await updateTypeMenu(owner, {
    status: "done",
    phase: null,
    menuId: "gid://shopify/Menu/1",
    finishedAt: new Date(),
  });

  await expect(page.getByText(/^Menu ready/).first()).toBeVisible({
    timeout: 45_000,
  });
  await expect(banner).toHaveCount(0);
  const loading = await page
    .locator('s-button[slot="primary-action"]')
    .evaluate((el) => (el as unknown as { loading?: boolean }).loading);
  expect(loading).not.toBe(true);
});
