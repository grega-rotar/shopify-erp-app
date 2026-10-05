import { useState } from "react";

import type {
  VariantFieldErrors,
  VariantInput,
} from "~/domain/products/workspace";
import { formatMoney } from "~/web/lib/money";
import { formatListDateTime } from "~/web/lib/datetime";
import type { ProductWorkspace } from "~/web/lib/product-workspace.server";
import { STATE_LABEL } from "~/web/lib/sales";

/**
 * What is sold: every variant with its SKU, barcode, price and compare-at,
 * its stock, whether MetaKocka has it, and whether a sale holds its price
 * (docs/architecture.md § Product workspace).
 *
 * A price a live campaign holds is shown, not offered: the campaign
 * recorded what to put back and expects to find its own price, so the
 * field states who manages it and links there (docs/sale-campaigns.md).
 * The server refuses the same edit whatever the form sends.
 */

type Variant = ProductWorkspace["variants"][number];

const MATCH_LABEL: Record<string, string> = {
  matched: "Matched",
  unmatched: "Not in MetaKocka",
  ignored: "Ignored",
};

function matchText(variant: Variant): string {
  if (!variant.sku) return "No SKU";
  if (!variant.match) return "Not read yet";
  return MATCH_LABEL[variant.match.status] ?? variant.match.status;
}

export function ProductVariants({
  workspace,
  inputs,
  errors,
  onChange,
}: {
  workspace: ProductWorkspace;
  inputs: Record<string, VariantInput>;
  errors: Record<string, VariantFieldErrors>;
  onChange: (variantId: string, patch: Partial<VariantInput>) => void;
}) {
  const { product, variants, currency, metakocka } = workspace;
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = q
    ? variants.filter(
        (v) =>
          v.title.toLowerCase().includes(q) ||
          (v.sku ?? "").toLowerCase().includes(q),
      )
    : variants;
  const single = product.hasOnlyDefaultVariant;
  const matched = variants.filter((v) => v.match?.status === "matched").length;

  return (
    <s-stack direction="block" gap="large">
      <s-section heading={single ? "Pricing and codes" : "Variants"}>
        <s-stack direction="block" gap="base">
          {!single && variants.length > 8 ? (
            <s-search-field
              label="Search variants"
              labelAccessibilityVisibility="exclusive"
              placeholder="Search by name or SKU"
              value={query}
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
          ) : null}

          {single && variants[0] ? (
            <SingleVariant
              variant={variants[0]}
              input={inputs[variants[0].variantId]}
              errors={errors[variants[0].variantId] ?? {}}
              currency={currency}
              onChange={onChange}
            />
          ) : (
            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header listSlot="primary">Variant</s-table-header>
                <s-table-header>SKU</s-table-header>
                <s-table-header>Barcode</s-table-header>
                <s-table-header>{`Price (${currency})`}</s-table-header>
                <s-table-header>{`Compare-at (${currency})`}</s-table-header>
                <s-table-header format="numeric">Available</s-table-header>
                <s-table-header listSlot="secondary">MetaKocka</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {shown.map((variant) => {
                  const input = inputs[variant.variantId];
                  const problems = errors[variant.variantId] ?? {};
                  if (!input) return null;
                  const held = variant.sale?.held ?? false;
                  return (
                    <s-table-row key={variant.variantId}>
                      <s-table-cell>
                        <s-stack direction="block" gap="small-500">
                          <s-text type="strong">{variant.title}</s-text>
                          {variant.sale ? (
                            <s-link
                              href={`/app/sales/${variant.sale.campaignId}`}
                            >
                              {`${variant.sale.campaignName} · ${STATE_LABEL[variant.sale.state as keyof typeof STATE_LABEL] ?? variant.sale.state}`}
                            </s-link>
                          ) : null}
                        </s-stack>
                      </s-table-cell>
                      <s-table-cell>
                        <s-box minInlineSize="140px">
                          <s-text-field
                            label={`SKU of ${variant.title}`}
                            labelAccessibilityVisibility="exclusive"
                            value={input.sku}
                            onInput={(event) =>
                              onChange(variant.variantId, {
                                sku: event.currentTarget.value,
                              })
                            }
                            {...(problems.sku ? { error: problems.sku } : {})}
                          />
                        </s-box>
                      </s-table-cell>
                      <s-table-cell>
                        <s-box minInlineSize="150px">
                          <s-text-field
                            label={`Barcode of ${variant.title}`}
                            labelAccessibilityVisibility="exclusive"
                            value={input.barcode}
                            onInput={(event) =>
                              onChange(variant.variantId, {
                                barcode: event.currentTarget.value,
                              })
                            }
                            {...(problems.barcode
                              ? { error: problems.barcode }
                              : {})}
                          />
                        </s-box>
                      </s-table-cell>
                      <s-table-cell>
                        {held ? (
                          <HeldPrice variant={variant} currency={currency} />
                        ) : (
                          <s-box maxInlineSize="140px">
                            <s-money-field
                              label={`Price of ${variant.title}`}
                              labelAccessibilityVisibility="exclusive"
                              value={input.price}
                              onInput={(event) =>
                                onChange(variant.variantId, {
                                  price: event.currentTarget.value,
                                })
                              }
                              {...(problems.price
                                ? { error: problems.price }
                                : {})}
                            />
                          </s-box>
                        )}
                      </s-table-cell>
                      <s-table-cell>
                        {held ? (
                          <s-text>
                            {variant.compareAtMinor === null
                              ? "—"
                              : formatMoney(variant.compareAtMinor, currency)}
                          </s-text>
                        ) : (
                          <s-box maxInlineSize="140px">
                            <s-money-field
                              label={`Compare-at price of ${variant.title}`}
                              labelAccessibilityVisibility="exclusive"
                              value={input.compareAt}
                              onInput={(event) =>
                                onChange(variant.variantId, {
                                  compareAt: event.currentTarget.value,
                                })
                              }
                              {...(problems.compareAt
                                ? { error: problems.compareAt }
                                : {})}
                            />
                          </s-box>
                        )}
                      </s-table-cell>
                      <s-table-cell>
                        {variant.inventoryQuantity === null
                          ? "—"
                          : variant.inventoryQuantity}
                      </s-table-cell>
                      <s-table-cell>
                        <s-text
                          tone={
                            !variant.sku ||
                            variant.match?.status === "unmatched"
                              ? "caution"
                              : "auto"
                          }
                        >
                          {matchText(variant)}
                        </s-text>
                      </s-table-cell>
                    </s-table-row>
                  );
                })}
              </s-table-body>
            </s-table>
          )}

          {product.variantsCount > product.variantsShown ? (
            <s-text color="subdued">
              {`Showing the first ${product.variantsShown} of ${product.variantsCount} variants. Edit the rest in Shopify.`}
            </s-text>
          ) : null}
          {variants.some((v) => v.sale?.held) ? (
            <s-text color="subdued">
              Prices on sale are managed by their campaign until it ends; the
              campaign puts the original price back.
            </s-text>
          ) : null}
          {metakocka.pricing ? (
            <s-text color="subdued">
              Product sync copies prices to your MetaKocka pricelist on each
              run.
            </s-text>
          ) : null}
        </s-stack>
      </s-section>

      <s-section heading="MetaKocka">
        <s-stack direction="block" gap="small-300">
          <s-text>
            {variants.length === 1
              ? matchText(variants[0] as Variant) === "Matched"
                ? `Matched to ${variants[0]?.match?.metakockaName ? `“${variants[0].match.metakockaName}”` : "a MetaKocka product"} by SKU.`
                : `${matchText(variants[0] as Variant)}.`
              : `${matched} of ${variants.length} variants are matched to a MetaKocka product by SKU.`}
          </s-text>
          <s-text color="subdued">
            {`${
              metakocka.lastReadAt
                ? `Catalogues last compared ${formatListDateTime(metakocka.lastReadAt)}.`
                : "The catalogues have not been compared yet."
            } ${
              metakocka.nameSync
                ? "Product sync writes names to MetaKocka."
                : "Nothing is written to MetaKocka from here."
            } Changing a SKU unmatches it until MetaKocka has the new code.`}
          </s-text>
          <s-stack direction="inline" gap="small-300">
            <s-button href="/app/metakocka/products">View matching</s-button>
            <s-button variant="tertiary" href="/app/metakocka/products/sync">
              Product sync settings
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>
    </s-stack>
  );
}

function HeldPrice({
  variant,
  currency,
}: {
  variant: Variant;
  currency: string;
}) {
  const sale = variant.sale;
  return (
    <s-stack direction="block" gap="small-500">
      <s-text>{formatMoney(variant.priceMinor, currency)}</s-text>
      {sale ? (
        <s-text color="subdued">
          {`Managed by ${sale.campaignName}${
            sale.originalPriceMinor !== null
              ? `; ${formatMoney(sale.originalPriceMinor, currency)} goes back after`
              : ""
          }`}
        </s-text>
      ) : null}
    </s-stack>
  );
}

function SingleVariant({
  variant,
  input,
  errors,
  currency,
  onChange,
}: {
  variant: Variant;
  input: VariantInput | undefined;
  errors: VariantFieldErrors;
  currency: string;
  onChange: (variantId: string, patch: Partial<VariantInput>) => void;
}) {
  if (!input) return null;
  const held = variant.sale?.held ?? false;
  return (
    <s-stack direction="block" gap="base">
      {held && variant.sale ? (
        <s-banner
          tone="info"
          heading={`${variant.sale.campaignName} manages this price`}
        >
          <s-stack direction="block" gap="small-300">
            <s-paragraph>
              {`On sale at ${formatMoney(variant.priceMinor, currency)}${
                variant.sale.originalPriceMinor !== null
                  ? `; ${formatMoney(variant.sale.originalPriceMinor, currency)} goes back when it ends`
                  : ""
              }.`}
            </s-paragraph>
            <s-stack direction="inline">
              <s-button href={`/app/sales/${variant.sale.campaignId}`}>
                View campaign
              </s-button>
            </s-stack>
          </s-stack>
        </s-banner>
      ) : null}
      <s-query-container>
        <s-grid
          gridTemplateColumns="@container (inline-size <= 560px) 1fr, '1fr 1fr'"
          gap="base"
        >
          <s-money-field
            label={`Price (${currency})`}
            value={input.price}
            onInput={(event) =>
              onChange(variant.variantId, { price: event.currentTarget.value })
            }
            {...(held ? { disabled: true } : {})}
            {...(errors.price ? { error: errors.price } : {})}
          />
          <s-money-field
            label={`Compare-at price (${currency})`}
            value={input.compareAt}
            details="The “was” price shoppers see struck through."
            onInput={(event) =>
              onChange(variant.variantId, {
                compareAt: event.currentTarget.value,
              })
            }
            {...(held ? { disabled: true } : {})}
            {...(errors.compareAt ? { error: errors.compareAt } : {})}
          />
          <s-text-field
            label="SKU"
            value={input.sku}
            onInput={(event) =>
              onChange(variant.variantId, { sku: event.currentTarget.value })
            }
            {...(errors.sku ? { error: errors.sku } : {})}
          />
          <s-text-field
            label="Barcode"
            value={input.barcode}
            onInput={(event) =>
              onChange(variant.variantId, {
                barcode: event.currentTarget.value,
              })
            }
            {...(errors.barcode ? { error: errors.barcode } : {})}
          />
        </s-grid>
      </s-query-container>
      <s-text color="subdued">
        {`${variant.inventoryQuantity === null ? "Stock not tracked" : `${variant.inventoryQuantity} available across locations`}.`}
      </s-text>
    </s-stack>
  );
}
