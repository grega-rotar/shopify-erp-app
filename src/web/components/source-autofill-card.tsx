import { useEffect } from "react";
import { useFetcher } from "react-router";

import { SOURCE_ROUTES } from "~/web/lib/sources";

type Setting = {
  enabled: boolean;
  fillAttributes: boolean;
  autoApply: boolean;
};

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
  setting: Setting;
}) {
  const fetcher = useFetcher<{ ok: boolean; message: string }>();
  const pending = fetcher.formData;
  const current: Setting = pending
    ? {
        enabled: pending.get("enabled") === "true",
        fillAttributes: pending.get("fillAttributes") !== "false",
        autoApply: pending.get("autoApply") === "true",
      }
    : setting;
  const { enabled, fillAttributes, autoApply } = current;

  useEffect(() => {
    if (
      fetcher.state === "idle" &&
      fetcher.data?.ok &&
      typeof shopify !== "undefined"
    )
      shopify.toast.show(fetcher.data.message);
  }, [fetcher.state, fetcher.data]);

  const save = (change: Partial<Setting>) => {
    const next = { ...current, ...change };
    fetcher.submit(
      {
        sourceId,
        enabled: String(next.enabled),
        fillAttributes: String(next.fillAttributes),
        autoApply: String(next.autoApply),
      },
      { method: "post", action: SOURCE_ROUTES.categorization },
    );
  };

  return (
    <s-section heading="AI categorization">
      <s-stack direction="block" gap="base">
        <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="start">
          <s-stack direction="block" gap="small-500">
            <s-text type="strong">Categorize new products</s-text>
            <s-text color="subdued">
              {enabled
                ? `${fillAttributes ? "Product type and attributes are" : "The product type is"} ${autoApply ? "applied when the AI is confident, otherwise suggested for review." : "suggested for review."}`
                : "New products keep the type their source gives them."}
            </s-text>
          </s-stack>
          <s-switch
            label="Categorize new products"
            labelAccessibilityVisibility="exclusive"
            checked={enabled}
            onChange={(event) => save({ enabled: event.currentTarget.checked })}
          />
        </s-grid>
        {enabled ? (
          <s-stack direction="block" gap="small-300">
            <s-checkbox
              label="Also fill the type's attributes"
              checked={fillAttributes}
              onChange={(event) =>
                save({ fillAttributes: event.currentTarget.checked })
              }
            />
            <s-checkbox
              label="Apply automatically when the AI is confident"
              details="80% sure of the type or more. Anything less sure waits on Review."
              checked={autoApply}
              onChange={(event) =>
                save({ autoApply: event.currentTarget.checked })
              }
            />
          </s-stack>
        ) : null}
        <s-link href={SOURCE_ROUTES.categorization}>Every source</s-link>
        {fetcher.data && !fetcher.data.ok ? (
          <s-text tone="critical">{fetcher.data.message}</s-text>
        ) : null}
      </s-stack>
    </s-section>
  );
}
