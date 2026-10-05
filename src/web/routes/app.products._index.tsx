import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect, useState } from "react";
import {
  useLoaderData,
  useNavigate,
  useNavigation,
  useSearchParams,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import {
  PRODUCT_STATUS_FILTERS,
  catalogueFacetOptions,
  listCatalogueProducts,
  type ProductListRow,
  type ProductStatusFilter,
} from "~/adapters/db/repositories/product-workspace.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import {
  DEFAULT_PRODUCT_SORT,
  hasProductFilters,
  parseProductFilters,
  parseProductSort,
  type ProductColumn,
  type ProductSort,
} from "~/domain/products/product-list";
import {
  COLUMN_LABEL,
  ProductFilterChips,
  ProductViewOptions,
  useProductColumns,
} from "~/web/components/product-list-view";
import { formatListDateTime } from "~/web/lib/datetime";
import { formatMoney } from "~/web/lib/money";
import { principalFromSession } from "~/web/lib/principal.server";
import { STATUS_LABEL, productPath } from "~/web/lib/product-workspace";

/**
 * Products: the way into each product's workspace (docs/architecture.md
 * § Product workspace). A list of the catalogue snapshot — searched by
 * title, vendor, type or SKU, filtered by status and by vendor, product
 * type, category or tag, sorted, with the columns each viewer chooses —
 * where opening a row opens the product here rather than in Shopify's
 * editor. Sort and filters are in the address; the column layout is the
 * viewer's own, kept in their browser.
 *
 * It reads the snapshot, not Shopify, so it answers at once for any
 * catalogue size; the snapshot follows every `products/update` and is read
 * whole every night. The workspace itself reads the product live.
 */

const PAGE_SIZE = 50;

function statusFilter(value: string | null): ProductStatusFilter {
  return (PRODUCT_STATUS_FILTERS as readonly string[]).includes(value ?? "")
    ? (value as ProductStatusFilter)
    : "all";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  const status = statusFilter(url.searchParams.get("status"));
  const hideArchived = url.searchParams.get("archived") === "hide";
  const sort = parseProductSort(
    url.searchParams.get("sort"),
    url.searchParams.get("dir"),
  );
  const filters = parseProductFilters((facet) =>
    url.searchParams.getAll(facet),
  );
  const page = Math.max(
    1,
    Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1,
  );

  const [result, facetOptions] = await Promise.all([
    listCatalogueProducts(principal, {
      q,
      status,
      hideArchived,
      filters,
      sort,
      page,
      pageSize: PAGE_SIZE,
    }),
    catalogueFacetOptions(principal),
  ]);
  return {
    q,
    status,
    hideArchived,
    sort,
    filters,
    facetOptions,
    page,
    total: result.total,
    pages: Math.max(1, Math.ceil(result.total / PAGE_SIZE)),
    snapshotAt: result.snapshotAt?.toISOString() ?? null,
    rows: result.rows.map((row) => ({
      ...row,
      updatedAt: row.updatedAt?.toISOString() ?? null,
    })),
  };
};

const FILTER_LABEL: Record<ProductStatusFilter, string> = {
  all: "All",
  active: "Active",
  draft: "Draft",
  archived: "Archived",
};

type ListRow = Omit<ProductListRow, "updatedAt"> & { updatedAt: string | null };

function priceText(row: ListRow): string {
  if (row.minPriceMinor === null || !row.currency) return "—";
  return row.minPriceMinor === row.maxPriceMinor
    ? formatMoney(row.minPriceMinor, row.currency)
    : `${formatMoney(row.minPriceMinor, row.currency)} – ${formatMoney(row.maxPriceMinor ?? row.minPriceMinor, row.currency)}`;
}

/** How each column's heading lays out in the narrow, list form of the table. */
const COLUMN_HEADER: Record<
  ProductColumn,
  {
    listSlot: "inline" | "secondary" | "labeled";
    format?: "numeric" | "currency";
  }
> = {
  status: { listSlot: "inline" },
  category: { listSlot: "labeled" },
  productType: { listSlot: "secondary" },
  vendor: { listSlot: "labeled" },
  variants: { listSlot: "labeled", format: "numeric" },
  price: { listSlot: "labeled", format: "currency" },
  tags: { listSlot: "labeled" },
  updated: { listSlot: "labeled" },
};

function ColumnCell({ column, row }: { column: ProductColumn; row: ListRow }) {
  switch (column) {
    case "status":
      return (
        <s-table-cell>
          <s-badge
            {...(row.status === "DRAFT" ? { tone: "info" as const } : {})}
          >
            {STATUS_LABEL[row.status ?? ""] ?? "Unknown"}
          </s-badge>
        </s-table-cell>
      );
    case "category":
      return <s-table-cell>{row.categoryName || "—"}</s-table-cell>;
    case "productType":
      return <s-table-cell>{row.productType || "—"}</s-table-cell>;
    case "vendor":
      return <s-table-cell>{row.vendor || "—"}</s-table-cell>;
    case "variants":
      return <s-table-cell>{row.variants}</s-table-cell>;
    case "price":
      return <s-table-cell>{priceText(row)}</s-table-cell>;
    case "tags":
      return (
        <s-table-cell>
          {row.tags.length > 0 ? row.tags.join(", ") : "—"}
        </s-table-cell>
      );
    case "updated":
      return (
        <s-table-cell>
          {row.updatedAt ? formatListDateTime(row.updatedAt) : "—"}
        </s-table-cell>
      );
  }
}

/** The default sort stays out of the address. */
function sortParams(sort: ProductSort): {
  sort: string | null;
  dir: string | null;
} {
  const isDefault =
    sort.key === DEFAULT_PRODUCT_SORT.key &&
    sort.direction === DEFAULT_PRODUCT_SORT.direction;
  return isDefault
    ? { sort: null, dir: null }
    : { sort: sort.key, dir: sort.direction };
}

export default function Products() {
  const {
    q,
    status,
    hideArchived,
    sort,
    filters,
    facetOptions,
    page,
    pages,
    total,
    rows,
    snapshotAt,
  } = useLoaderData<typeof loader>();
  const [columns, setColumns] = useProductColumns();
  const visibleColumns = columns
    .filter((column) => column.visible)
    .map((column) => column.key);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const [search, setSearch] = useState(q);
  useEffect(() => setSearch(q), [q]);

  const listQuery = params.toString();
  const go = (patch: Record<string, string | readonly string[] | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(patch)) {
      next.delete(key);
      if (typeof value === "string") {
        if (value !== "") next.set(key, value);
      } else if (value) {
        for (const item of value) next.append(key, item);
      }
    }
    void navigate(
      `/app/products${next.toString() ? `?${next.toString()}` : ""}`,
    );
  };

  // A search is sent once typing pauses, not on every key.
  useEffect(() => {
    if (search.trim() === q) return;
    const timer = setTimeout(() => go({ q: search.trim(), page: null }), 350);
    return () => clearTimeout(timer);
  }, [search]);

  const open = (productId: string) => {
    const path = productPath(productId);
    void navigate(
      listQuery ? `${path}?list=${encodeURIComponent(`?${listQuery}`)}` : path,
    );
  };
  const loading =
    navigation.state === "loading" &&
    navigation.location.pathname === "/app/products";

  return (
    <s-page heading="Products" inlineSize="large">
      <s-section padding="none" accessibilityLabel="Products">
        <s-stack direction="block" gap="none">
          <s-box padding="small-200">
            <s-stack direction="block" gap="small-300">
              <s-stack direction="inline" gap="small-400">
                {(Object.keys(FILTER_LABEL) as ProductStatusFilter[]).map(
                  (key) =>
                    key === status ? (
                      <s-button
                        key={key}
                        variant="secondary"
                        accessibilityLabel={`${FILTER_LABEL[key]}, current view`}
                      >
                        {FILTER_LABEL[key]}
                      </s-button>
                    ) : (
                      <s-button
                        key={key}
                        variant="tertiary"
                        onClick={() =>
                          go({ status: key === "all" ? null : key, page: null })
                        }
                      >
                        {FILTER_LABEL[key]}
                      </s-button>
                    ),
                )}
              </s-stack>
              <s-grid
                gridTemplateColumns="1fr auto"
                gap="small-300"
                alignItems="center"
              >
                <s-search-field
                  label="Search products"
                  labelAccessibilityVisibility="exclusive"
                  placeholder="Search by title, vendor, type or SKU"
                  value={search}
                  onInput={(event) => setSearch(event.currentTarget.value)}
                />
                <ProductViewOptions
                  sort={sort}
                  onSortChange={(next) =>
                    go({ ...sortParams(next), page: null })
                  }
                  hideArchived={hideArchived}
                  onHideArchivedChange={(hide) =>
                    go({ archived: hide ? "hide" : null, page: null })
                  }
                  hideArchivedDisabled={status !== "all"}
                  columns={columns}
                  onColumnsChange={setColumns}
                />
              </s-grid>
              <ProductFilterChips
                filters={filters}
                options={facetOptions}
                onChange={(facet, values) =>
                  go({ [facet]: values, page: null })
                }
              />
            </s-stack>
          </s-box>

          {rows.length === 0 ? (
            <s-box padding="base">
              <s-text color="subdued">
                {total === 0 &&
                q === "" &&
                status === "all" &&
                !hideArchived &&
                !hasProductFilters(filters)
                  ? "The catalogue has not been read yet. It is read every night, and after a sale campaign asks for it."
                  : "No products match."}
              </s-text>
            </s-box>
          ) : (
            <s-table variant="auto" {...(loading ? { loading: true } : {})}>
              <s-table-header-row>
                <s-table-header listSlot="primary">Product</s-table-header>
                {visibleColumns.map((column) => {
                  const { listSlot, format } = COLUMN_HEADER[column];
                  return (
                    <s-table-header
                      key={column}
                      listSlot={listSlot}
                      {...(format ? { format } : {})}
                    >
                      {COLUMN_LABEL[column]}
                    </s-table-header>
                  );
                })}
              </s-table-header-row>
              <s-table-body>
                {rows.map((row) => (
                  <s-table-row
                    key={row.productId}
                    clickDelegate={`open-${row.productId}`}
                  >
                    <s-table-cell>
                      <s-stack
                        direction="inline"
                        gap="small-300"
                        alignItems="center"
                      >
                        <s-box inlineSize="40px" blockSize="40px">
                          {row.imageUrl ? (
                            <s-image
                              src={row.imageUrl}
                              alt=""
                              inlineSize="fill"
                              objectFit="contain"
                              loading="lazy"
                            />
                          ) : null}
                        </s-box>
                        <s-stack direction="block" gap="small-500">
                          <s-link
                            id={`open-${row.productId}`}
                            href={productPath(row.productId)}
                            onClick={(event) => {
                              event.preventDefault();
                              open(row.productId);
                            }}
                          >
                            {row.title}
                          </s-link>
                          {row.sku ? (
                            <s-text color="subdued">{row.sku}</s-text>
                          ) : null}
                        </s-stack>
                      </s-stack>
                    </s-table-cell>
                    {visibleColumns.map((column) => (
                      <ColumnCell key={column} column={column} row={row} />
                    ))}
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}

          <s-box padding="small-200">
            <s-grid
              gridTemplateColumns="1fr auto"
              gap="base"
              alignItems="center"
            >
              <s-text color="subdued">
                {`${total} ${total === 1 ? "product" : "products"}${
                  snapshotAt
                    ? ` · catalogue read ${formatListDateTime(snapshotAt)}`
                    : ""
                }`}
              </s-text>
              {pages > 1 ? (
                <s-stack direction="inline" gap="small-300" alignItems="center">
                  <s-button
                    icon="chevron-left"
                    accessibilityLabel="Previous page"
                    onClick={() =>
                      go({ page: page - 1 <= 1 ? null : String(page - 1) })
                    }
                    {...(page <= 1 ? { disabled: true } : {})}
                  />
                  <s-text color="subdued">{`${page} of ${pages}`}</s-text>
                  <s-button
                    icon="chevron-right"
                    accessibilityLabel="Next page"
                    onClick={() => go({ page: String(page + 1) })}
                    {...(page >= pages ? { disabled: true } : {})}
                  />
                </s-stack>
              ) : null}
            </s-grid>
          </s-box>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
