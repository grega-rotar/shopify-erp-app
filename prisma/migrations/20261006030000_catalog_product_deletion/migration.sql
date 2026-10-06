-- Products Shopify deleted, remembered so a late products/update or a bulk
-- read already in flight cannot put them back into the catalogue snapshot
-- (docs/sale-campaigns.md § catalog_product).
--
-- Additive: nothing existing is changed or backfilled.

-- CreateTable
CREATE TABLE "catalog_product_deletion" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "shopify_product_id" TEXT NOT NULL,
    "deleted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_product_deletion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "catalog_product_deletion_shop_id_shopify_product_id_key" ON "catalog_product_deletion"("shop_id", "shopify_product_id");

-- AddForeignKey
ALTER TABLE "catalog_product_deletion" ADD CONSTRAINT "catalog_product_deletion_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
