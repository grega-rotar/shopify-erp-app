import { useEffect } from "react";
import { useFetcher } from "react-router";

import { SOURCE_ROUTES } from "~/web/lib/sources";

/**
 * A source's AI categorization in its sidebar (docs/sources.md § AI
 * categorization per source): on or off, and what it fills, changed in
 * place. The same setting as the row on the AI categorization page, saved
 * through that page's action.
 */
export function SourceAutofillCard({
  sourceId,
  setting,
}: {
  sourceId: string;
  setting: { enabled: boolean; fillAttributes: boolean };
}) {
  const fetcher = useFetcher<{ ok: boolean; message: string }>();
  const pending = fetcher.formData;
  const enabled = pending
    ? pending.get("enabled") === "true"
    : setting.enabled;
  const fillAttributes = pending
    ? pending.get("fillAttributes") !== "false"
    : setting.fillAttributes;

  useEffect(() => {
    if (
      fetcher.state === "idle" &&
      fetcher.data?.ok &&
      typeof shopify !== "undefined"
    )
      shopify.toast.show(fetcher.data.message);
  }, [fetcher.state, fetcher.data]);

  const save = (next: { enabled: boolean; fillAttributes: boolean }) =>
    fetcher.submit(
      {
        sourceId,
        enabled: String(next.enabled),
        fillAttributes: String(next.fillAttributes),
      },
      { method: "post", action: SOURCE_ROUTES.categorization },
    );

  return (
    <s-section heading="AI categorization">
      <s-stack direction="block" gap="base">
        <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="start">
          <s-stack direction="block" gap="small-500">
            <s-text type="strong">Categorize new products</s-text>
            <s-text color="subdued">
              {enabled
                ? fillAttributes
                  ? "Product type and attributes are suggested for review."
                  : "The product type is suggested for review."
                : "New products keep the type their source gives them."}
            </s-text>
          </s-stack>
          <s-switch
            label="Categorize new products"
            labelAccessibilityVisibility="exclusive"
            checked={enabled}
            onChange={(event) =>
              save({ enabled: event.currentTarget.checked, fillAttributes })
            }
          />
        </s-grid>
        {enabled ? (
          <s-checkbox
            label="Also fill the type's attributes"
            checked={fillAttributes}
            onChange={(event) =>
              save({ enabled: true, fillAttributes: event.currentTarget.checked })
            }
          />
        ) : null}
        <s-link href={SOURCE_ROUTES.categorization}>Every source</s-link>
        {fetcher.data && !fetcher.data.ok ? (
          <s-text tone="critical">{fetcher.data.message}</s-text>
        ) : null}
      </s-stack>
    </s-section>
  );
}
