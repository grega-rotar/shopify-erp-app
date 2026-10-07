-- AI categorization per source may apply a confident suggestion at once
-- instead of waiting for review (docs/attributes.md § AI autofill).
--
-- Additive: every existing source keeps waiting for review.

-- AlterTable
ALTER TABLE "source_autofill" ADD COLUMN "auto_apply" BOOLEAN NOT NULL DEFAULT false;
