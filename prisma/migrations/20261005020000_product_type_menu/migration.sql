-- The store menu made from the product type tree (docs/attributes.md
-- § Store menu): the metafield definition, collections and menu this app
-- created in Shopify, and the state of the latest run. One row per shop.
--
-- Additive: nothing existing is changed or backfilled.

-- CreateTable
CREATE TABLE "product_type_menu" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "definition_id" TEXT,
    "menu_id" TEXT,
    "collections" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL,
    "phase" TEXT,
    "total" INTEGER NOT NULL DEFAULT 0,
    "done" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "requested_by" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_type_menu_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "product_type_menu_shop_id_key" ON "product_type_menu"("shop_id");

-- AddForeignKey
ALTER TABLE "product_type_menu" ADD CONSTRAINT "product_type_menu_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
