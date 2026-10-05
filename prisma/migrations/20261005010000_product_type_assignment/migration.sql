-- The product type a person chose for a product (docs/attributes.md
-- § On the product page). One row per shop and product; it outranks the
-- match by category or Shopify product type.
--
-- Additive: nothing existing is changed or backfilled.

-- CreateTable
CREATE TABLE "product_type_assignment" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "type_id" TEXT NOT NULL,
    "chosen_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_type_assignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "product_type_assignment_shop_id_product_id_key" ON "product_type_assignment"("shop_id", "product_id");

-- CreateIndex
CREATE INDEX "product_type_assignment_shop_id_type_id_idx" ON "product_type_assignment"("shop_id", "type_id");

-- AddForeignKey
ALTER TABLE "product_type_assignment" ADD CONSTRAINT "product_type_assignment_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
