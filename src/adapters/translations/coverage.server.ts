import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import { readTranslatableResources } from "~/adapters/shopify/translations";
import {
  accumulateResource,
  coverageRows,
  newCoverage,
} from "~/domain/translations/coverage";
import type { CoverageRow } from "~/domain/translations/estimate";
import {
  RESOURCE_TYPE_LABEL,
  keptKeys,
  type KeepOriginal,
  type ResourceType,
} from "~/domain/translations/types";

/**
 * One pass over every translatable resource of the given types, counting
 * (docs/translations.md § Coverage). Reads only; the counts go to the cache
 * through the repository by the job that called this.
 *
 * A type Shopify will not read — a scope the merchant has not approved, a
 * type this store does not have — costs that type, not the count: the other
 * types are still counted and the failures come back named, so the caller
 * can keep what was read and still report what was not.
 */

const PAGE = 50;

export interface CoverageScan {
  rows: CoverageRow[];
  /** Types that could not be read, with Shopify's reason. */
  unread: Array<{ type: ResourceType; reason: string }>;
}

export async function scanCoverage(
  admin: AdminApiContext,
  input: {
    types: readonly ResourceType[];
    locales: readonly string[];
    /** Per locale, the fields kept in the source language. */
    keepOriginal?: ReadonlyMap<string, readonly KeepOriginal[]>;
  },
  onProgress?: (done: { type: ResourceType; resources: number }) => void,
): Promise<CoverageScan> {
  const acc = newCoverage();
  const unread: CoverageScan["unread"] = [];
  if (input.locales.length === 0) return { rows: [], unread };

  for (const type of input.types) {
    let after: string | null = null;
    let seen = 0;
    // Counted apart and merged only once the type was read whole, so a
    // failure on page four does not leave three pages' worth in the cache.
    const typeAcc = newCoverage();
    try {
      for (;;) {
        const page = await readTranslatableResources(admin, {
          type,
          first: PAGE,
          after,
          locales: input.locales,
        });
        for (const resource of page.resources) {
          accumulateResource(typeAcc, {
            resourceType: type,
            fields: resource.fields,
            translations: resource.translations,
            locales: input.locales,
            keep: (locale) =>
              keptKeys(input.keepOriginal?.get(locale) ?? [], type),
          });
        }
        seen += page.resources.length;
        if (!page.hasNextPage || !page.endCursor) break;
        after = page.endCursor;
      }
    } catch (error) {
      unread.push({
        type,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    for (const [key, row] of typeAcc) acc.set(key, row);
    onProgress?.({ type, resources: seen });
  }
  return { rows: coverageRows(acc), unread };
}

/** One sentence naming what could not be read, for a job's failure and the page. */
export function describeUnread(unread: CoverageScan["unread"]): string {
  return unread
    .map(({ type, reason }) => `${RESOURCE_TYPE_LABEL[type]}: ${reason}`)
    .join("; ");
}
