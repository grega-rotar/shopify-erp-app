-- The coverage count as it runs (docs/translations.md § Coverage).
--
-- The store-wide count used to be one job that read every translatable
-- resource, with nothing to show while it ran: a page could only say
-- "counting" until it ended, and on a large store it outlived its expiry
-- and started again. It now runs in chunks and writes its progress here,
-- one row per shop, so a page shows how far it is and whether it stopped.
--
-- Additive: one new table.

-- CreateTable
CREATE TABLE "translation_coverage_scan" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "types_total" INTEGER NOT NULL,
    "types_done" INTEGER NOT NULL DEFAULT 0,
    "current_type" TEXT,
    "resources_read" INTEGER NOT NULL DEFAULT 0,
    "expected_resources" INTEGER,
    "unread" JSONB,
    "error" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL,
    "heartbeat_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "translation_coverage_scan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "translation_coverage_scan_shop_id_key" ON "translation_coverage_scan"("shop_id");

-- AddForeignKey
ALTER TABLE "translation_coverage_scan" ADD CONSTRAINT "translation_coverage_scan_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
