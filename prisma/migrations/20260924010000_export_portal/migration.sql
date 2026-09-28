-- Export portal connection (docs/sources.md).
--
-- One API key per shop, generated in the export portal's admin and pasted
-- into the Sources connection page. Encrypted at rest like every other
-- secret; the tenant the portal answered with is kept as a label.
--
-- Additive: one new table.

-- CreateTable
CREATE TABLE "export_portal_connection" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "api_key_encrypted" TEXT NOT NULL,
    "tenant_id" TEXT,
    "tenant_name" TEXT,
    "last_verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "export_portal_connection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "export_portal_connection_shop_id_key" ON "export_portal_connection"("shop_id");

-- AddForeignKey
ALTER TABLE "export_portal_connection" ADD CONSTRAINT "export_portal_connection_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
