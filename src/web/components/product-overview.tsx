import { Fragment, type ReactNode } from "react";

import type { WorkspaceTab } from "~/domain/products/workspace";
import { PageColumns } from "~/web/components/page-columns";
import { formatListDateTime } from "~/web/lib/datetime";
import { htmlToText } from "~/web/lib/html";
import { formatMoney } from "~/web/lib/money";
import type { ProductWorkspace } from "~/web/lib/product-workspace.server";
import { STATUS_LABEL } from "~/web/lib/product-workspace";
import { describeDiscount, formatInZone } from "~/web/lib/sales";

/**
 * The first thing a merchant sees on a product (docs/architecture.md
 * § Product workspace): what needs doing, if anything; what the product is;
 * what is being sold and at what; and, in the column beside, one line per
 * system that has a say — Shopify, MetaKocka, a source, the translations,
 * the product setup plan. Each line leads to where it is dealt with.
 *
 * Nothing is scored. A problem is named once, with where to fix it, and a
 * product with none shows no problem section at all.
 */
export function ProductOverview({
  workspace,
  onTab,
}: {
  workspace: ProductWorkspace;
  onTab: (tab: WorkspaceTab) => void;
}) {
  const { product, fields, issues, variants, currency, sales, source } =
    workspace;
  const excerpt = htmlToText(fields.descriptionHtml).slice(0, 360);
  const prices = variants.map((v) => v.priceMinor);
  const low = prices.length > 0 ? Math.min(...prices) : null;
  const high = prices.length > 0 ? Math.max(...prices) : null;
  const available = variants.reduce(
    (sum, v) => sum + Math.max(0, v.inventoryQuantity ?? 0),
    0,
  );
  const tracked = variants.some((v) => v.inventoryQuantity !== null);
  const outOfStock = variants.filter(
    (v) => v.inventoryQuantity !== null && v.inventoryQuantity <= 0,
  ).length;

  return (
    <PageColumns aside={<StatusCard workspace={workspace} onTab={onTab} />}>
      {issues.length > 0 ? (
        <s-section heading="Needs attention">
          <s-stack direction="block" gap="none">
            {issues.map((issue, index) => (
              <s-box
                key={issue.key}
                paddingBlock="small-300"
                {...(index > 0
                  ? {
                      borderWidth: "small none none none" as const,
                      borderStyle: "solid none none none" as const,
                      borderColor: "subdued" as const,
                    }
                  : {})}
              >
                <s-grid
                  gridTemplateColumns="1fr auto"
                  gap="base"
                  alignItems="center"
                >
                  <s-text>{issue.text}</s-text>
                  {"tab" in issue.target ? (
                    <s-button
                      variant="tertiary"
                      onClick={() =>
                        "tab" in issue.target && onTab(issue.target.tab)
                      }
                    >
                      {issue.action}
                    </s-button>
                  ) : (
                    <s-button variant="tertiary" href={issue.target.href}>
                      {issue.action}
                    </s-button>
                  )}
                </s-grid>
              </s-box>
            ))}
          </s-stack>
        </s-section>
      ) : null}

      <s-section>
        <CardHeader heading="Product">
          <s-button variant="tertiary" onClick={() => onTab("details")}>
            Edit
          </s-button>
        </CardHeader>
        <s-query-container>
          <s-grid
            gridTemplateColumns="@container (inline-size <= 560px) 1fr, '160px minmax(0, 1fr)'"
            gap="base"
            alignItems="start"
          >
            <s-box
              inlineSize="160px"
              blockSize="160px"
              border="base"
              borderRadius="base"
              overflow="hidden"
            >
              {product.imageUrl ? (
                <s-image
                  src={product.imageUrl}
                  alt=""
                  inlineSize="fill"
                  aspectRatio="1/1"
                  objectFit="contain"
                />
              ) : null}
            </s-box>
            <s-stack direction="block" gap="small-200">
              <s-text color={excerpt ? "base" : "subdued"}>
                {excerpt
                  ? `${excerpt}${htmlToText(fields.descriptionHtml).length > excerpt.length ? "…" : ""}`
                  : "No description yet."}
              </s-text>
              <Facts
                rows={[
                  ["Vendor", fields.vendor || "—"],
                  ["Product type", fields.productType || "—"],
                  ["Category", product.category?.fullName ?? "—"],
                  [
                    "Collections",
                    product.collections.length > 0
                      ? product.collections.map((c) => c.title).join(", ")
                      : "—",
                  ],
                ]}
              />
            </s-stack>
          </s-grid>
        </s-query-container>
      </s-section>

      <s-section>
        <CardHeader
          heading={
            product.hasOnlyDefaultVariant
              ? "Selling"
              : `${product.variantsCount} variants`
          }
        >
          <s-button variant="tertiary" onClick={() => onTab("inventory")}>
            Stock
          </s-button>
          <s-button variant="tertiary" onClick={() => onTab("variants")}>
            {product.hasOnlyDefaultVariant ? "Edit price" : "Edit variants"}
          </s-button>
        </CardHeader>
        <Facts
          rows={[
            [
              "Price",
              low === null
                ? "—"
                : low === high
                  ? formatMoney(low, currency)
                  : `${formatMoney(low, currency)} – ${formatMoney(high ?? low, currency)}`,
            ],
            [
              "Stock",
              !tracked
                ? "Not tracked"
                : `${available} available${outOfStock > 0 && !product.hasOnlyDefaultVariant ? `, ${outOfStock} ${outOfStock === 1 ? "variant" : "variants"} out of stock` : ""}`,
            ],
            ...(product.options.length > 0 && !product.hasOnlyDefaultVariant
              ? ([["Options", product.options.join(", ")]] as Array<
                  [string, string]
                >)
              : []),
          ]}
        />
      </s-section>

      <AttributesCard setup={workspace.setup} onTab={onTab} />

      {sales.length > 0 ? (
        <s-section heading={sales.length === 1 ? "Sale" : "Sales"}>
          <s-stack direction="block" gap="base">
            {sales.map((sale) => (
              <s-grid
                key={sale.id}
                gridTemplateColumns="1fr auto"
                gap="base"
                alignItems="center"
              >
                <s-stack direction="block" gap="small-500">
                  <s-text type="strong">{sale.name}</s-text>
                  <s-text color="subdued">
                    {[
                      discountText(sale),
                      `${sale.onSale} of ${variants.length} ${variants.length === 1 ? "variant" : "variants"} on sale`,
                      sale.status === "scheduled" && sale.startsAt
                        ? `starts ${when(sale.startsAt, workspace.timeZone)}`
                        : sale.endsAt
                          ? `ends ${when(sale.endsAt, workspace.timeZone)}`
                          : "no end date",
                    ].join(" · ")}
                  </s-text>
                  {sale.problems > 0 ? (
                    <s-text tone="critical">
                      {`The original price could not be put back on ${sale.problems}.`}
                    </s-text>
                  ) : null}
                </s-stack>
                <s-button href={`/app/sales/${sale.id}`}>
                  View campaign
                </s-button>
              </s-grid>
            ))}
          </s-stack>
        </s-section>
      ) : null}

      {source ? (
        <s-section heading="Source">
          <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
            <s-stack direction="block" gap="small-500">
              <s-text type="strong">
                {source.name ?? "An export portal source"}
              </s-text>
              <s-text color="subdued">
                {source.read
                  ? [
                      source.kind,
                      source.lastRunAt
                        ? `last ran ${formatListDateTime(source.lastRunAt)}`
                        : "has not run yet",
                    ]
                      .filter(Boolean)
                      .join(" · ")
                  : (source.message ??
                    "The export portal could not be asked about it just now.")}
              </s-text>
              <s-text color="subdued">
                The source created this product and updates its content on each
                run.
              </s-text>
            </s-stack>
            <s-button href={`/app/sources/${encodeURIComponent(source.id)}`}>
              View source
            </s-button>
          </s-grid>
        </s-section>
      ) : null}
    </PageColumns>
  );
}

function discountText(sale: ProductWorkspace["sales"][number]): string {
  const type = sale.discount.type;
  if (
    type !== "percentage" &&
    type !== "fixed_amount" &&
    type !== "fixed_price"
  )
    return "";
  return describeDiscount({ type, value: sale.discount.value }, sale.currency);
}

function when(iso: string, timeZone: string | null): string {
  return timeZone ? formatInZone(iso, timeZone) : formatListDateTime(iso);
}

/**
 * A card's title with its actions at the trailing edge, the way the admin's
 * own cards carry theirs, so a button belongs to its card instead of
 * floating under the content.
 */
function CardHeader({
  heading,
  children,
}: {
  heading: string;
  children?: ReactNode;
}) {
  return (
    <s-box paddingBlockEnd="small-200">
      <s-grid
        gridTemplateColumns="minmax(0, 1fr) auto"
        gap="base"
        alignItems="center"
      >
        <s-heading>{heading}</s-heading>
        {children ? (
          <s-stack direction="inline" gap="small-300">
            {children}
          </s-stack>
        ) : null}
      </s-grid>
    </s-box>
  );
}

/**
 * Label and value pairs. The label column has a set width, so a value sits
 * beside its label however wide the card is.
 */
function Facts({ rows }: { rows: Array<[string, string]> }) {
  return (
    <s-query-container>
      <s-grid
        gridTemplateColumns="@container (inline-size <= 420px) '8rem minmax(0, 1fr)', '11rem minmax(0, 1fr)'"
        columnGap="base"
        rowGap="small-300"
      >
        {rows.map(([label, value]) => (
          <Fragment key={label}>
            <s-text color="subdued">{label}</s-text>
            <s-text>{value}</s-text>
          </Fragment>
        ))}
      </s-grid>
    </s-query-container>
  );
}

/** What the product setup plan asks of this product, as far as it is filled in. */
function AttributesCard({
  setup,
  onTab,
}: {
  setup: ProductWorkspace["setup"];
  onTab: (tab: WorkspaceTab) => void;
}) {
  if (setup.kind === "no_plan" || setup.kind === "unavailable") return null;
  if (setup.kind !== "matched")
    return (
      <s-section>
        <CardHeader heading="Attributes">
          <s-button variant="tertiary" onClick={() => onTab("attributes")}>
            Choose type
          </s-button>
        </CardHeader>
        <s-text color="subdued">
          No product type is chosen yet, so there is nothing to fill in. Choose
          its type to see the attributes it needs.
        </s-text>
      </s-section>
    );

  const { completeness } = setup;
  const filled = completeness.groups
    .flatMap((group) => group.rows)
    .filter((row) => row.value !== null);
  const shown = filled.slice(0, 8);
  return (
    <s-section>
      <CardHeader heading="Attributes">
        <s-button variant="tertiary" onClick={() => onTab("attributes")}>
          Edit
        </s-button>
      </CardHeader>
      <s-stack direction="block" gap="small-300">
        <Facts
          rows={[
            ["Product type", setup.path.join(" › ")],
            ...shown.map(
              (row) => [row.name, row.value ?? ""] as [string, string],
            ),
          ]}
        />
        <s-text
          color="subdued"
          tone={completeness.missingRequired.length > 0 ? "caution" : "auto"}
        >
          {[
            completeness.requiredTotal > 0
              ? `${completeness.requiredComplete} of ${completeness.requiredTotal} required filled in`
              : null,
            filled.length > shown.length
              ? `${filled.length - shown.length} more filled in`
              : null,
            filled.length === 0 ? "Nothing filled in yet" : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </s-text>
      </s-stack>
    </s-section>
  );
}

/** One line per system with a say in this product, each leading to its place. */
function StatusCard({
  workspace,
  onTab,
}: {
  workspace: ProductWorkspace;
  onTab: (tab: WorkspaceTab) => void;
}) {
  const { product, variants, translations, setup, source, awaitingReview } =
    workspace;
  const withSku = variants.filter((v) => v.sku);
  const matched = variants.filter((v) => v.match?.status === "matched").length;
  const published = translations.ok
    ? translations.languages.filter((l) => l.published)
    : [];
  const complete = published.filter(
    (l) => l.missing === 0 && l.outdated === 0,
  ).length;

  const rows: Array<{
    label: string;
    value: string;
    tab?: WorkspaceTab;
    href?: string;
    caution?: boolean;
  }> = [
    {
      label: "Shopify",
      value: awaitingReview
        ? "Draft, waiting for review"
        : (STATUS_LABEL[product.status] ?? product.status),
    },
    {
      label: "MetaKocka",
      value:
        withSku.length === 0
          ? "No SKU to match"
          : variants.length === 1
            ? matched === 1
              ? "Matched"
              : variants[0]?.match
                ? "Not matched"
                : "Not compared yet"
            : `${matched} of ${variants.length} matched`,
      tab: "variants",
      caution:
        withSku.length > 0 &&
        matched < variants.length &&
        variants.some((v) => v.match),
    },
    ...(source
      ? [
          {
            label: "Source",
            value: source.name ?? "Export portal",
            href: `/app/sources/${encodeURIComponent(source.id)}`,
          },
        ]
      : []),
    {
      label: "Translations",
      value: !translations.ok
        ? "Could not be read"
        : published.length === 0
          ? "No other published language"
          : complete === published.length
            ? `Complete in ${published.length} ${published.length === 1 ? "language" : "languages"}`
            : `${complete} of ${published.length} languages complete`,
      tab: "translations",
      caution: translations.ok && complete < published.length,
    },
    ...(setup.kind === "matched"
      ? [
          {
            label: "Product setup",
            value:
              setup.completeness.requiredTotal === 0
                ? (setup.path[setup.path.length - 1] ?? "Matched")
                : `${setup.completeness.requiredComplete} of ${setup.completeness.requiredTotal} required`,
            tab: "attributes" as const,
            caution: setup.completeness.missingRequired.length > 0,
          },
        ]
      : setup.kind === "none" || setup.kind === "ambiguous"
        ? [
            {
              label: "Product setup",
              value: "No product type chosen",
              tab: "attributes" as const,
            },
          ]
        : []),
  ];

  return (
    <s-section heading="Status">
      <s-stack direction="block" gap="none">
        {rows.map((row, index) => (
          <s-box
            key={row.label}
            paddingBlock="small-300"
            {...(index > 0
              ? {
                  borderWidth: "small none none none" as const,
                  borderStyle: "solid none none none" as const,
                  borderColor: "subdued" as const,
                }
              : {})}
          >
            <s-grid
              gridTemplateColumns="minmax(0, 1fr) auto"
              gap="base"
              alignItems="center"
            >
              <s-stack direction="block" gap="small-500">
                <s-text color="subdued">{row.label}</s-text>
                <s-text tone={row.caution ? "caution" : "auto"}>
                  {row.value}
                </s-text>
              </s-stack>
              {row.tab ? (
                <s-button
                  variant="tertiary"
                  icon="chevron-right"
                  accessibilityLabel={`${row.label}: view`}
                  onClick={() => row.tab && onTab(row.tab)}
                />
              ) : row.href ? (
                <s-button
                  variant="tertiary"
                  icon="chevron-right"
                  accessibilityLabel={`${row.label}: view`}
                  href={row.href}
                />
              ) : null}
            </s-grid>
          </s-box>
        ))}
      </s-stack>
    </s-section>
  );
}
