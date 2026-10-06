/**
 * The product list's view (docs/architecture.md § Product list): how it is
 * sorted, which facets filter it, and which columns it shows in what order.
 * Sort and filters live in the address so a list can be linked and the
 * workspace can return to it; columns are a viewer's preference and live in
 * their browser. Everything here reads untrusted input and falls back to the
 * default rather than failing.
 */

export const PRODUCT_SORT_KEYS = [
  "title",
  "updated",
  "productType",
  "vendor",
  "category",
] as const;
export type ProductSortKey = (typeof PRODUCT_SORT_KEYS)[number];
export type SortDirection = "asc" | "desc";

export interface ProductSort {
  key: ProductSortKey;
  direction: SortDirection;
}

export const DEFAULT_PRODUCT_SORT: ProductSort = {
  key: "title",
  direction: "asc",
};

/** A newest-first default for dates, A to Z for words. */
export function defaultDirection(key: ProductSortKey): SortDirection {
  return key === "updated" ? "desc" : "asc";
}

export function parseProductSort(
  key: string | null,
  direction: string | null,
): ProductSort {
  if (!(PRODUCT_SORT_KEYS as readonly string[]).includes(key ?? "")) {
    return DEFAULT_PRODUCT_SORT;
  }
  const sortKey = key as ProductSortKey;
  return {
    key: sortKey,
    direction:
      direction === "asc" || direction === "desc"
        ? direction
        : defaultDirection(sortKey),
  };
}

/** The facets a list can be narrowed by, each "is any of" its values. */
export const PRODUCT_FACETS = [
  "vendor",
  "productType",
  "category",
  "tag",
] as const;
export type ProductFacet = (typeof PRODUCT_FACETS)[number];
export type ProductFilters = Record<ProductFacet, string[]>;

/** Facet values are capped so an address cannot ask for an unbounded `IN`. */
const MAX_VALUES_PER_FACET = 50;

export function parseProductFilters(
  getAll: (facet: ProductFacet) => readonly string[],
): ProductFilters {
  const filters = {} as ProductFilters;
  for (const facet of PRODUCT_FACETS) {
    filters[facet] = [
      ...new Set(
        getAll(facet)
          .map((value) => value.trim())
          .filter((value) => value !== ""),
      ),
    ].slice(0, MAX_VALUES_PER_FACET);
  }
  return filters;
}

export function hasProductFilters(filters: ProductFilters): boolean {
  return PRODUCT_FACETS.some((facet) => filters[facet].length > 0);
}

/* -------------------------------------------------------------------------- */
/* Columns                                                                    */
/* -------------------------------------------------------------------------- */

/** Every column but Product, which always leads and cannot be hidden. */
export const PRODUCT_COLUMNS = [
  "status",
  "category",
  "productType",
  "vendor",
  "variants",
  "price",
  "tags",
  "updated",
] as const;
export type ProductColumn = (typeof PRODUCT_COLUMNS)[number];

export interface ColumnSetting {
  key: ProductColumn;
  visible: boolean;
}

const HIDDEN_BY_DEFAULT: ReadonlySet<ProductColumn> = new Set([
  "tags",
  "updated",
]);

export const DEFAULT_PRODUCT_COLUMNS: readonly ColumnSetting[] =
  PRODUCT_COLUMNS.map((key) => ({ key, visible: !HIDDEN_BY_DEFAULT.has(key) }));

/**
 * A stored column layout, made whole: unknown and repeated keys dropped,
 * and any column the stored layout predates added at the end, so a column
 * added later appears instead of staying lost.
 */
export function normalizeColumns(stored: unknown): ColumnSetting[] {
  if (!Array.isArray(stored)) return [...DEFAULT_PRODUCT_COLUMNS];
  const seen = new Set<ProductColumn>();
  const columns: ColumnSetting[] = [];
  for (const item of stored as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const key: unknown = (item as { key?: unknown }).key;
    const visible: unknown = (item as { visible?: unknown }).visible;
    if (
      typeof key !== "string" ||
      !(PRODUCT_COLUMNS as readonly string[]).includes(key) ||
      seen.has(key as ProductColumn)
    ) {
      continue;
    }
    seen.add(key as ProductColumn);
    columns.push({ key: key as ProductColumn, visible: visible !== false });
  }
  for (const column of DEFAULT_PRODUCT_COLUMNS) {
    if (!seen.has(column.key)) columns.push({ ...column });
  }
  return columns;
}

/** Moves the column at `from` to `to`, both clamped into the list. */
export function moveColumn(
  columns: readonly ColumnSetting[],
  from: number,
  to: number,
): ColumnSetting[] {
  const next = [...columns];
  if (from < 0 || from >= next.length) return next;
  const target = Math.max(0, Math.min(next.length - 1, to));
  const [moved] = next.splice(from, 1);
  if (moved) next.splice(target, 0, moved);
  return next;
}
