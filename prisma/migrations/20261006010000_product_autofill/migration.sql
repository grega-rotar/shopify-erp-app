-- What AI autofill suggested for a product (docs/attributes.md § AI
-- autofill): a product type and attribute values held for a person to apply
-- or discard. One row per shop and product.
--
-- Additive: nothing existing is changed or backfilled.

-- CreateTable
CREATE TABLE "product_autofill" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "type_id" TEXT,
    "type_origin" TEXT,
    "type_confidence" DOUBLE PRECISION,
    "type_reason" TEXT,
    "values" JSONB NOT NULL DEFAULT '[]',
    "engine" TEXT,
    "error" TEXT,
    "requested_by" TEXT,
    "decided_by" TEXT,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_autofill_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "product_autofill_shop_id_product_id_key" ON "product_autofill"("shop_id", "product_id");

-- CreateIndex
CREATE INDEX "product_autofill_shop_id_status_idx" ON "product_autofill"("shop_id", "status");

-- AddForeignKey
ALTER TABLE "product_autofill" ADD CONSTRAINT "product_autofill_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
