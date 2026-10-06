-- Whether a source's new products are put to AI autofill as they arrive
-- (docs/sources.md § AI categorization per source). One row per shop and
-- export portal source; no row means off.
--
-- Additive: nothing existing is changed or backfilled.

-- CreateTable
CREATE TABLE "source_autofill" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "fill_attributes" BOOLEAN NOT NULL DEFAULT true,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "source_autofill_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "source_autofill_shop_id_source_id_key" ON "source_autofill"("shop_id", "source_id");

-- AddForeignKey
ALTER TABLE "source_autofill" ADD CONSTRAINT "source_autofill_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
