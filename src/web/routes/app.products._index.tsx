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
  listCatalogueProducts,
  type ProductStatusFilter,
} from "~/adapters/db/repositories/product-workspace.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { formatListDateTime } from "~/web/lib/datetime";
import { formatMoney } from "~/web/lib/money";
import { principalFromSession } from "~/web/lib/principal.server";
import { STATUS_LABEL, productPath } from "~/web/lib/product-workspace";

/**
 * Products: the way into each product's workspace (docs/architecture.md
 * § Product workspace). A list of the catalogue snapshot — searched by
 * title, vendor, type or SKU, filtered by status — where opening a row
 * opens the product here rather than in Shopify's editor.
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
  const page = Math.max(
    1,
    Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1,
  );

  const result = await listCatalogueProducts(principal, {
    q,
    status,
    page,
    pageSize: PAGE_SIZE,
  });
  return {
    q,
    status,
    page,
    total: result.total,
    pages: Math.max(1, Math.ceil(result.total / PAGE_SIZE)),
    snapshotAt: result.snapshotAt?.toISOString() ?? null,
    rows: result.rows,
  };
};

const FILTER_LABEL: Record<ProductStatusFilter, string> = {
  all: "All",
  active: "Active",
  draft: "Draft",
  archived: "Archived",
};

export default function Products() {
  const { q, status, page, pages, total, rows, snapshotAt } =
    useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const [search, setSearch] = useState(q);
  useEffect(() => setSearch(q), [q]);

  const listQuery = params.toString();
  const go = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
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
              <s-search-field
                label="Search products"
                labelAccessibilityVisibility="exclusive"
                placeholder="Search by title, vendor, type or SKU"
                value={search}
                onInput={(event) => setSearch(event.currentTarget.value)}
              />
            </s-stack>
          </s-box>

          {rows.length === 0 ? (
            <s-box padding="base">
              <s-text color="subdued">
                {total === 0 && q === "" && status === "all"
                  ? "The catalogue has not been read yet. It is read every night, and after a sale campaign asks for it."
                  : "No products match."}
              </s-text>
            </s-box>
          ) : (
            <s-table variant="auto" {...(loading ? { loading: true } : {})}>
              <s-table-header-row>
                <s-table-header listSlot="primary">Product</s-table-header>
                <s-table-header listSlot="inline">Status</s-table-header>
                <s-table-header listSlot="secondary">Type</s-table-header>
                <s-table-header listSlot="secondary">Vendor</s-table-header>
                <s-table-header listSlot="secondary" format="numeric">
                  Variants
                </s-table-header>
                <s-table-header listSlot="secondary" format="currency">
                  Price
                </s-table-header>
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
                    <s-table-cell>
                      <s-badge
                        {...(row.status === "DRAFT"
                          ? { tone: "info" as const }
                          : {})}
                      >
                        {STATUS_LABEL[row.status ?? ""] ?? "Unknown"}
                      </s-badge>
                    </s-table-cell>
                    <s-table-cell>{row.productType || "—"}</s-table-cell>
                    <s-table-cell>{row.vendor || "—"}</s-table-cell>
                    <s-table-cell>{row.variants}</s-table-cell>
                    <s-table-cell>
                      {row.minPriceMinor === null || !row.currency
                        ? "—"
                        : row.minPriceMinor === row.maxPriceMinor
                          ? formatMoney(row.minPriceMinor, row.currency)
                          : `${formatMoney(row.minPriceMinor, row.currency)} – ${formatMoney(row.maxPriceMinor ?? row.minPriceMinor, row.currency)}`}
                    </s-table-cell>
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
