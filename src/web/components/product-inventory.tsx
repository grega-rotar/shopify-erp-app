import type { ProductWorkspace } from "~/web/lib/product-workspace.server";
import { describeStockWriter } from "~/web/lib/product-workspace";

/**
 * Stock by location, read-only (docs/architecture.md § Product workspace).
 *
 * Each location's numbers have one writer (docs/BUILD_SPEC.md §7): MetaKocka
 * through the stock sync, Shopify with this app copying it to MetaKocka, a
 * fulfilment service, or nobody this app knows of. The page says which
 * rather than offering a quantity field another process would overwrite;
 * counting stock stays in Shopify and in MetaKocka, and which way it flows
 * is Locations' to decide.
 */
export function ProductInventory({
  workspace,
}: {
  workspace: ProductWorkspace;
}) {
  const { stock, product } = workspace;

  if (!stock.ok)
    return (
      <s-section heading="Inventory">
        <s-text color="subdued">{stock.message}</s-text>
      </s-section>
    );

  if (stock.locations.length === 0)
    return (
      <s-section heading="Inventory">
        <s-stack direction="block" gap="small-300">
          <s-text>This product is not stocked at any location.</s-text>
          <s-stack direction="inline">
            <s-button
              href={`shopify://admin/products/${product.legacyId}`}
              target="_blank"
            >
              Manage inventory in Shopify
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>
    );

  return (
    <s-stack direction="block" gap="large">
      <s-section heading="Where the numbers come from">
        <s-stack direction="block" gap="none">
          {stock.locations.map((location, index) => (
            <s-box
              key={location.id}
              paddingBlock="small-300"
              {...(index > 0
                ? {
                    borderWidth: "small none none none" as const,
                    borderStyle: "solid none none none" as const,
                    borderColor: "subdued" as const,
                  }
                : {})}
            >
              <s-query-container>
                <s-grid
                  gridTemplateColumns="@container (inline-size <= 560px) 1fr, 'minmax(0, 1fr) minmax(0, 2fr)'"
                  gap="small-300"
                  alignItems="baseline"
                >
                  <s-text type="strong">{location.name}</s-text>
                  <s-stack direction="block" gap="small-500">
                    <s-text color="subdued">
                      {describeStockWriter(location.writer)}
                    </s-text>
                    {location.syncMessage ? (
                      <s-text tone="critical">{location.syncMessage}</s-text>
                    ) : null}
                  </s-stack>
                </s-grid>
              </s-query-container>
            </s-box>
          ))}
        </s-stack>
        {!stock.locationsRead ? (
          <s-text color="subdued">
            Which system writes each location could not be read just now.
          </s-text>
        ) : null}
        <s-stack direction="inline" gap="small-300">
          <s-button href="/app/metakocka/locations">Locations</s-button>
          <s-button
            variant="tertiary"
            href={`shopify://admin/products/${product.legacyId}`}
            target="_blank"
          >
            Adjust stock in Shopify
          </s-button>
        </s-stack>
      </s-section>

      <s-section heading="Stock">
        <s-table variant="auto">
          <s-table-header-row>
            <s-table-header listSlot="primary">
              {product.hasOnlyDefaultVariant ? "Product" : "Variant"}
            </s-table-header>
            {stock.locations.map((location) => (
              <s-table-header key={location.id}>{location.name}</s-table-header>
            ))}
          </s-table-header-row>
          <s-table-body>
            {stock.rows.map((row) => (
              <s-table-row key={row.variantId}>
                <s-table-cell>
                  <s-stack direction="block" gap="small-500">
                    <s-text>
                      {product.hasOnlyDefaultVariant
                        ? product.title
                        : row.title}
                    </s-text>
                    {row.sku ? (
                      <s-text color="subdued">{row.sku}</s-text>
                    ) : null}
                  </s-stack>
                </s-table-cell>
                {stock.locations.map((location) => {
                  const level = row.levels[location.id];
                  return (
                    <s-table-cell key={location.id}>
                      {!row.tracked ? (
                        <s-text color="subdued">Not tracked</s-text>
                      ) : level ? (
                        <s-stack direction="block" gap="small-500">
                          <s-text>{`${level.available} available`}</s-text>
                          {level.onHand !== level.available ? (
                            <s-text color="subdued">{`${level.onHand} on hand`}</s-text>
                          ) : null}
                        </s-stack>
                      ) : (
                        <s-text color="subdued">Not stocked</s-text>
                      )}
                    </s-table-cell>
                  );
                })}
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>
    </s-stack>
  );
}
