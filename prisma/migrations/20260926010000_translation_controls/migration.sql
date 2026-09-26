-- Translation failures and kept fields (docs/translations.md § Failures,
-- § Kept in the original language).
--
-- A failed translation used to be retried by every automatic pass: the
-- nightly sync and every products/update webhook, which a stock change
-- sends. Each retry paid the provider again for the same failure. This
-- remembers the last failure per resource and language, with the source it
-- failed on and when automatic work may try again.
--
-- A language may also keep fields in the source language (product names,
-- option values, ...): the AI never translates them and coverage does not
-- count them as missing.
--
-- Additive: one new table, one new column with a default.

-- AlterTable
ALTER TABLE "translation_language" ADD COLUMN     "keep_original" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "translation_failure" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "source_key" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "last_error" TEXT NOT NULL,
    "failed_at" TIMESTAMP(3) NOT NULL,
    "retry_after" TIMESTAMP(3),

    CONSTRAINT "translation_failure_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "translation_failure_shop_id_resource_id_locale_key" ON "translation_failure"("shop_id", "resource_id", "locale");

-- AddForeignKey
ALTER TABLE "translation_failure" ADD CONSTRAINT "translation_failure_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
