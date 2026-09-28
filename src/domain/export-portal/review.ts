import { isTranslatableField } from "~/domain/translations/plan";
import type {
  ExistingTranslation,
  SourceField,
} from "~/domain/translations/types";

/**
 * Review before publish (docs/sources.md § Review before publish).
 *
 * A source in review mode has the portal create each new product as a
 * draft carrying `REVIEW_TAG`, and a tag naming the source it came from. A
 * person looks the draft over here, has it translated, and approves it:
 * this app sets it active and takes the review tag off. The tags are the
 * whole contract between the two — nothing about a product under review is
 * stored in this app.
 */
export const REVIEW_TAG = "awaiting-review";
export const SOURCE_TAG_PREFIX = "portal-source:";

/** Shopify's search syntax quotes a value; a quote inside one is escaped. */
function quoted(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The products search that finds what is waiting: drafts that still carry
 * the review tag. Both conditions, because a product someone set active in
 * the Shopify admin is no longer waiting, whatever its tags say.
 */
export function reviewQuery(input: {
  sourceId?: string | null;
  search?: string | null;
}): string {
  const parts = [`tag:${quoted(REVIEW_TAG)}`, "status:draft"];
  if (input.sourceId)
    parts.push(`tag:${quoted(`${SOURCE_TAG_PREFIX}${input.sourceId}`)}`);
  const search = input.search?.trim();
  // Free text, as the admin's own search box: title, SKU, vendor and the rest.
  if (search) parts.push(quoted(search));
  return parts.join(" AND ");
}

/** The source a product came from, read off its tags; null when none says. */
export function sourceIdFromTags(tags: readonly string[]): string | null {
  const tag = tags.find((t) => t.startsWith(SOURCE_TAG_PREFIX));
  const id = tag?.slice(SOURCE_TAG_PREFIX.length).trim();
  return id ? id : null;
}

/** Whether a product is one this area may approve. */
export function isAwaitingReview(product: {
  status: string;
  tags: readonly string[];
}): boolean {
  return product.status === "DRAFT" && product.tags.includes(REVIEW_TAG);
}

/** What one language still lacks on one product. */
export interface LocaleGap {
  locale: string;
  missing: number;
  outdated: number;
}

/**
 * What each language still lacks, counted the way coverage counts it: a
 * field with nothing to translate, or one the language keeps in the
 * original, is not missing. Languages lacking nothing are left out, so an
 * empty answer means the product is ready in every language asked about.
 */
export function translationGaps(input: {
  fields: readonly SourceField[];
  translations: ReadonlyMap<string, readonly ExistingTranslation[]>;
  locales: readonly string[];
  kept: (locale: string) => ReadonlySet<string>;
}): LocaleGap[] {
  const fields = input.fields.filter(isTranslatableField);
  const gaps: LocaleGap[] = [];
  for (const locale of input.locales) {
    const kept = input.kept(locale);
    const existing = new Map(
      (input.translations.get(locale) ?? []).map((t) => [t.key, t]),
    );
    let missing = 0;
    let outdated = 0;
    for (const field of fields) {
      if (kept.has(field.key)) continue;
      const translation = existing.get(field.key);
      if (!translation || translation.value === "") missing += 1;
      else if (translation.outdated) outdated += 1;
    }
    if (missing > 0 || outdated > 0) gaps.push({ locale, missing, outdated });
  }
  return gaps;
}
