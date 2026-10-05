import type { StockWriter, WorkspaceTab } from "~/domain/products/workspace";
import type { ActivityItem } from "~/web/components/recent-activity";

/**
 * The product workspace's words (docs/architecture.md § Product workspace):
 * its sections, the product's trail as sentences, and who writes stock.
 * Shared by the loader and the page so an event reads the same everywhere
 * and no event name from the log reaches a merchant.
 */

export const WORKSPACE_TABS: ReadonlyArray<{
  key: WorkspaceTab;
  label: string;
}> = [
  { key: "overview", label: "Overview" },
  { key: "details", label: "Product details" },
  { key: "attributes", label: "Attributes" },
  { key: "variants", label: "Variants" },
  { key: "inventory", label: "Inventory" },
  { key: "translations", label: "Translations" },
  { key: "activity", label: "Activity" },
];

export function isWorkspaceTab(value: string | null): value is WorkspaceTab {
  return WORKSPACE_TABS.some((tab) => tab.key === value);
}

export function productPath(productId: string, tab?: WorkspaceTab): string {
  const number = productId.replace(/^gid:\/\/shopify\/Product\//, "");
  return `/app/products/${number}${tab && tab !== "overview" ? `?tab=${tab}` : ""}`;
}

export const STATUS_LABEL: Record<string, string> = {
  ACTIVE: "Active",
  DRAFT: "Draft",
  ARCHIVED: "Archived",
};

/** Who sets a location's stock, as the row states it. */
export function describeStockWriter(writer: StockWriter): string {
  switch (writer.kind) {
    case "fulfillment_service":
      return `Set by ${writer.service}`;
    case "metakocka":
      return writer.paused
        ? `From MetaKocka${writer.warehouse ? ` (${writer.warehouse})` : ""}, paused`
        : `From MetaKocka${writer.warehouse ? ` (${writer.warehouse})` : ""}`;
    case "shopify":
      return writer.paused
        ? "Counted in Shopify; copying to MetaKocka is paused"
        : `Counted in Shopify, copied to MetaKocka${writer.warehouse ? ` (${writer.warehouse})` : ""}`;
    case "none":
      return "Not synced by this app";
  }
}

/** Whether the numbers at a location are another system's to change. */
export function stockIsSynced(writer: StockWriter): boolean {
  return writer.kind === "metakocka" || writer.kind === "fulfillment_service";
}

interface TrailEntry {
  id: string;
  at: string;
  entityType: string;
  entityId: string | null;
  event: string;
  detail: unknown;
}

interface AiWork {
  id: string;
  at: string;
  locale: string;
  status: string;
  fields: number;
}

function record(detail: unknown): Record<string, unknown> {
  return detail && typeof detail === "object" && !Array.isArray(detail)
    ? (detail as Record<string, unknown>)
    : {};
}

function fieldsText(n: number): string {
  return n === 1 ? "1 field" : `${n} fields`;
}

const FIELD_NAMES: Record<string, string> = {
  title: "title",
  descriptionHtml: "description",
  vendor: "vendor",
  productType: "product type",
  status: "status",
  tags: "tags",
  seoTitle: "page title",
  seoDescription: "meta description",
};

function listText(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * One trail entry as a sentence, or null for an entry that says nothing a
 * merchant looking at this product needs. Never the event's own name.
 */
function describeEntry(
  entry: TrailEntry,
  context: {
    languageName: (locale: string) => string;
    variantTitle: (id: string) => string | null;
    singleVariant: boolean;
  },
): Omit<ActivityItem, "id" | "at"> | null {
  const d = record(entry.detail);
  const variant =
    entry.entityType === "sale_variant" &&
    entry.entityId &&
    !context.singleVariant
      ? context.variantTitle(entry.entityId)
      : null;
  const onVariant = variant ? ` (${variant})` : "";

  switch (entry.event) {
    case "product.edited": {
      const fields = Array.isArray(d.fields)
        ? d.fields.map((f) => FIELD_NAMES[String(f)] ?? "details")
        : [];
      return {
        title: "Product",
        text:
          fields.length > 0
            ? `Changed the ${listText(fields)} here.`
            : "Edited here.",
        ok: true,
      };
    }
    case "product.variants_edited": {
      const count = Number(d.variants ?? 0);
      return {
        title: "Variants",
        text: `Changed ${count === 1 ? "1 variant" : `${count} variants`} here.`,
        ok: true,
      };
    }
    case "product.details_edited": {
      const count = Number(d.values ?? 0);
      return {
        title: "Product details",
        text: `Changed ${count === 1 ? "1 value" : `${count} values`} of the product setup plan here.`,
        ok: true,
      };
    }
    case "product.type_chosen":
      return {
        title: "Product type",
        text:
          typeof d.type === "string" && d.type !== ""
            ? `Set as ${d.type} here.`
            : "Left to match by category or product type again.",
        ok: true,
      };
    case "product.review_approved":
      return { title: "Product", text: "Approved and published.", ok: true };
    case "translation.edited": {
      const locale =
        typeof d.locale === "string"
          ? context.languageName(d.locale)
          : "A language";
      const written = Number(d.written ?? 0);
      const removed = Number(d.removed ?? 0);
      return {
        title: `${locale} translation`,
        text:
          written > 0
            ? `${fieldsText(written)} edited by a person${removed > 0 ? `, ${removed} cleared` : ""}.`
            : `${fieldsText(removed)} cleared.`,
        ok: true,
      };
    }
    case "translation.source_changed":
      return {
        title: "Translations",
        text: "The language it is written in was changed.",
        ok: true,
      };
    case "sale_variant.price_changed":
      return {
        title: "Sale",
        text: `Sale price applied${onVariant}.`,
        ok: true,
      };
    case "sale_variant.restored":
      return {
        title: "Sale",
        text: `Original price put back${onVariant}.`,
        ok: true,
      };
    case "sale_variant.apply_failed":
      return {
        title: "Sale",
        text: `Shopify rejected the sale price${onVariant}.`,
        ok: false,
      };
    case "sale_variant.restore_failed":
      return {
        title: "Sale",
        text: `Shopify rejected putting the price back${onVariant}.`,
        ok: false,
      };
    case "sale_variant.external_change_detected":
      return {
        title: "Sale",
        text: `The price was changed outside the campaign${onVariant}.`,
        ok: false,
      };
    case "sale_variant.review_resolved":
      return {
        title: "Sale",
        text: `A price decision was made${onVariant}.`,
        ok: true,
      };
    case "sale_variant.released":
      return {
        title: "Sale",
        text: `Released from a campaign${onVariant}.`,
        ok: true,
      };
    case "sale_variant.skipped":
      return {
        title: "Sale",
        text: `Left out of a campaign${onVariant}.`,
        ok: true,
      };
    default:
      return null;
  }
}

/** The product's trail and the AI's work on it, as one list, newest first. */
export function describeProductTrail(input: {
  trail: readonly TrailEntry[];
  aiWork: readonly AiWork[];
  languageName: (locale: string) => string;
  variantTitle: (id: string) => string | null;
  singleVariant: boolean;
}): ActivityItem[] {
  const items: ActivityItem[] = [];
  for (const entry of input.trail) {
    const described = describeEntry(entry, input);
    if (described) items.push({ id: entry.id, at: entry.at, ...described });
  }
  for (const work of input.aiWork) {
    const language = input.languageName(work.locale);
    items.push({
      id: `ai-${work.id}`,
      at: work.at,
      title: `${language} translation`,
      text:
        work.status === "failed"
          ? "The AI could not translate it."
          : work.status === "copied"
            ? "Already written in this language; the original was kept."
            : `${fieldsText(work.fields)} translated by AI.`,
      ok: work.status !== "failed",
    });
  }
  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 40);
}
