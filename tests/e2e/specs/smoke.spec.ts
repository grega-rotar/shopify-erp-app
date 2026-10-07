import { expect, test } from "../support/test";

test("the app home renders for a new shop", async ({ page, shop }) => {
  await page.goto("/app");
  await expect(page.locator("s-page")).toBeVisible();
  void shop;
});
