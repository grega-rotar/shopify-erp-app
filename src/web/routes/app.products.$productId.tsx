import { boundary } from "@shopify/shopify-app-react-router/server";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  useFetcher,
  useLoaderData,
  useSearchParams,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
  type ShouldRevalidateFunction,
} from "react-router";

import { isConfigured } from "~/adapters/ai/openai.server";
import { getAttributeSchema } from "~/adapters/db/repositories/attribute-schema.server";
import {
  getAutofill,
  readyAutofillProductIds,
} from "~/adapters/db/repositories/product-autofill.server";
import { assignableTypes } from "~/domain/products/attribute-values";
import { autofillAvailability } from "~/adapters/products/autofill.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import {
  sameInput,
  type AttributeInput,
  type AttributeInputs,
} from "~/domain/products/attribute-values";
import {
  moneyInput,
  productChanges,
  type ProductFieldErrors,
  type ProductFields,
  type VariantFieldErrors,
  type VariantInput,
  type WorkspaceTab,
} from "~/domain/products/workspace";
import { ConfirmModal } from "~/web/components/confirm-modal";
import { ProductAttributes } from "~/web/components/product-attributes";
import { ProductAutofill } from "~/web/components/product-autofill";
import { ProductDetails } from "~/web/components/product-details";
import { ProductInventory } from "~/web/components/product-inventory";
import { ProductOverview } from "~/web/components/product-overview";
import { ProductTranslations } from "~/web/components/product-translations";
import { ProductVariants } from "~/web/components/product-variants";
import { formatDateTime } from "~/web/lib/datetime";
import { isAutofillWorking } from "~/web/lib/autofill";
import { autofillView } from "~/web/lib/autofill.server";
import { useLiveRevalidation } from "~/web/lib/live";
import {
  actorFromSession,
  principalFromSession,
} from "~/web/lib/principal.server";
import {
  STATUS_LABEL,
  WORKSPACE_TABS,
  isWorkspaceTab,
  productPath,
} from "~/web/lib/product-workspace";
import {
  handleProductAction,
  type ProductActionResult,
} from "~/web/lib/product-actions.server";
import {
  loadProductWorkspace,
  productGid,
} from "~/web/lib/product-workspace.server";
import { useResetWhenSaved, useSaveBar } from "~/web/lib/use-save-bar";

/**
 * One product, managed from inside the app (docs/architecture.md § Product
 * workspace): what it is, whether it is complete, what is sold at what
 * price, where its stock comes from, how it reads in every language, and
 * what happened to it — with the fields this app can safely change edited
 * in place. Shopify's own editor is one button away for everything else.
 *
 * The sections are tabs in the address (`?tab=`), so a link can open one
 * and switching does not re-read the product. The product's own fields and
 * its variants are one form behind the contextual save bar; translations
 * save from their own dialog, because they are a different owner's record.
 */

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const workspace = await loadProductWorkspace(
    admin,
    principal,
    productGid(String(params.productId ?? "")),
  );
  if (!workspace) throw new Response("Not found", { status: 404 });
  const list = new URL(request.url).searchParams.get("list") ?? "";
  const productId = productGid(String(params.productId ?? ""));
  const [{ schema }, autofill, autofillReady] = await Promise.all([
    getAttributeSchema(principal),
    getAutofill(principal, productId),
    autofillAvailability(principal),
  ]);
  // The review queue: the next product whose suggestion waits, so a person
  // can work through them one after another (docs/attributes.md § AI autofill).
  const waiting = await readyAutofillProductIds(principal);
  const nextId =
    waiting.find(
      (id, index) => index > waiting.indexOf(productId) && id !== productId,
    ) ??
    waiting.find((id) => id !== productId) ??
    null;
  return {
    workspace,
    aiConfigured: isConfigured(),
    autofill: autofillView(schema, autofill),
    autofillTypes: assignableTypes(schema).map((type) => ({
      value: type.id,
      label: type.path.join(" › "),
    })),
    nextReview: nextId ? productPath(nextId, "attributes") : null,
    reviewWaiting: waiting.length,
    autofillAvailable: autofillReady.ok
      ? { ok: true as const }
      : { ok: false as const, message: autofillReady.message },
    /** The list's own query, so the way back keeps its search and page. */
    back: list.startsWith("?") ? `/app/products${list}` : "/app/products",
  };
};

export const action = async ({
  request,
  params,
}: ActionFunctionArgs): Promise<ProductActionResult> => {
  const { session, admin } = await authenticate.admin(request);
  return handleProductAction({
    admin,
    principal: principalFromSession(session),
    actor: actorFromSession(session),
    productId: productGid(String(params.productId ?? "")),
    formData: await request.formData(),
  });
};

/** Switching tabs is not a reason to read the product again. */
export const shouldRevalidate: ShouldRevalidateFunction = ({
  currentUrl,
  nextUrl,
  formMethod,
  defaultShouldRevalidate,
}) => {
  if (formMethod && formMethod !== "GET") return defaultShouldRevalidate;
  if (currentUrl.pathname !== nextUrl.pathname) return defaultShouldRevalidate;
  const before = new URLSearchParams(currentUrl.search);
  const next = new URLSearchParams(nextUrl.search);
  before.delete("tab");
  next.delete("tab");
  if (before.toString() === next.toString()) return false;
  return defaultShouldRevalidate;
};

const SAVE_BAR_ID = "product-save-bar";
const CONFIRM_ID = "product-save-confirm";

function variantInputs(
  variants: ReadonlyArray<{
    variantId: string;
    priceMinor: number;
    compareAtMinor: number | null;
    sku: string | null;
    barcode: string | null;
  }>,
): Record<string, VariantInput> {
  return Object.fromEntries(
    variants.map((variant) => [
      variant.variantId,
      {
        variantId: variant.variantId,
        price: moneyInput(variant.priceMinor),
        compareAt: moneyInput(variant.compareAtMinor),
        sku: variant.sku ?? "",
        barcode: variant.barcode ?? "",
      },
    ]),
  );
}

export default function ProductWorkspacePage() {
  const {
    workspace,
    aiConfigured,
    autofill,
    autofillAvailable,
    autofillTypes,
    nextReview,
    reviewWaiting,
    back,
  } = useLoaderData<typeof loader>();
  const { product } = workspace;
  const [params, setParams] = useSearchParams();
  const rawTab = params.get("tab");
  const tab: WorkspaceTab = isWorkspaceTab(rawTab) ? rawTab : "overview";
  const showTab = useCallback(
    (next: WorkspaceTab) => {
      setParams(
        (current) => {
          const updated = new URLSearchParams(current);
          if (next === "overview") updated.delete("tab");
          else updated.set("tab", next);
          return updated;
        },
        { replace: true, preventScrollReset: true },
      );
    },
    [setParams],
  );

  /* ---------------------------- The one form ----------------------------- */

  const savedVariants = useMemo(
    () => variantInputs(workspace.variants),
    [workspace.variants],
  );
  const [fields, setFields] = useState<ProductFields>(workspace.fields);
  const [variants, setVariants] =
    useState<Record<string, VariantInput>>(savedVariants);
  const savedAttributes = useMemo<AttributeInputs>(
    () => (workspace.setup.kind === "matched" ? workspace.setup.inputs : {}),
    [workspace.setup],
  );
  const [attributes, setAttributes] =
    useState<AttributeInputs>(savedAttributes);
  const savedKey = JSON.stringify([
    workspace.fields,
    savedVariants,
    savedAttributes,
  ]);
  useResetWhenSaved(
    savedKey,
    useCallback(() => {
      setFields(workspace.fields);
      setVariants(savedVariants);
      setAttributes(savedAttributes);
    }, [workspace.fields, savedVariants, savedAttributes]),
  );

  const touchedVariants = Object.values(variants).filter((input) => {
    const was = savedVariants[input.variantId];
    return (
      was !== undefined &&
      (was.price !== input.price ||
        was.compareAt !== input.compareAt ||
        was.sku !== input.sku ||
        was.barcode !== input.barcode)
    );
  });
  const productDiff = productChanges(workspace.fields, fields);
  const productDirty =
    Object.keys(productDiff.change).length > 0 ||
    productDiff.add.length > 0 ||
    productDiff.remove.length > 0;
  const attributesDirty = Object.entries(attributes).some(
    ([key, input]) => !sameInput(savedAttributes[key], input),
  );
  const dirty = productDirty || touchedVariants.length > 0 || attributesDirty;
  useSaveBar(SAVE_BAR_ID, dirty);
  // Re-read what others change, but never under someone's unsaved edits;
  // closely while AI suggestions are being made for this product.
  useLiveRevalidation({
    active: !dirty && isAutofillWorking(autofill),
    idleEveryMs: dirty ? null : 60_000,
  });

  const saver = useFetcher<ProductActionResult>();
  const saving = saver.state !== "idle";
  const result = saver.data;
  const fieldErrors: ProductFieldErrors =
    result && !result.ok ? (result.fieldErrors ?? {}) : {};
  const variantErrors: Record<string, VariantFieldErrors> =
    result && !result.ok ? (result.variantErrors ?? {}) : {};
  const attributeErrors: Record<string, string> =
    result && !result.ok ? (result.attributeErrors ?? {}) : {};

  useEffect(() => {
    if (saver.state === "idle" && result?.ok && typeof shopify !== "undefined")
      shopify.toast.show(result.message);
  }, [saver.state, result]);

  /*
   * What this save does beyond the fields: taking a product off the
   * storefront, and unmatching a variant from its MetaKocka product. Both
   * are said before the save, in one confirmation.
   */
  const consequences: string[] = [];
  if (
    fields.status !== workspace.fields.status &&
    workspace.fields.status === "ACTIVE"
  )
    consequences.push(
      fields.status === "ARCHIVED"
        ? "The product is archived and disappears from every sales channel."
        : "The product becomes a draft and disappears from every sales channel.",
    );
  const reSkued = touchedVariants.filter((input) => {
    const variant = workspace.variants.find(
      (v) => v.variantId === input.variantId,
    );
    return (
      variant?.match?.status === "matched" &&
      (variant.sku ?? "") !== input.sku.trim()
    );
  });
  if (reSkued.length > 0)
    consequences.push(
      `${reSkued.length === 1 ? "1 variant is" : `${reSkued.length} variants are`} matched to MetaKocka by SKU. With a new SKU, stock and orders stop matching until MetaKocka has a product with that code.`,
    );

  const submit = () => {
    saver.submit(
      {
        intent: "save",
        form: JSON.stringify({
          pageRead: workspace.fields,
          fields,
          variants: touchedVariants.map((input) => {
            const variant = workspace.variants.find(
              (v) => v.variantId === input.variantId,
            );
            return {
              ...input,
              was: variant
                ? {
                    variantId: variant.variantId,
                    priceMinor: variant.priceMinor,
                    compareAtMinor: variant.compareAtMinor,
                    sku: variant.sku,
                    barcode: variant.barcode,
                  }
                : null,
            };
          }),
          attributes:
            attributesDirty && workspace.setup.kind === "matched"
              ? {
                  typeId: workspace.setup.typeId,
                  pageRead: savedAttributes,
                  inputs: attributes,
                }
              : null,
        }),
      },
      { method: "post" },
    );
  };
  const save = () => {
    if (consequences.length > 0) {
      const modal = document.getElementById(CONFIRM_ID) as {
        showOverlay?: () => void;
      } | null;
      modal?.showOverlay?.();
      return;
    }
    submit();
  };
  const discard = () => {
    setFields(workspace.fields);
    setVariants(savedVariants);
    setAttributes(savedAttributes);
  };

  const storefront = product.onlineStoreUrl ?? product.previewUrl;
  const oneSku =
    workspace.variants.length === 1 ? workspace.variants[0]?.sku : null;

  return (
    <s-page heading={product.title} inlineSize="large">
      <s-link slot="breadcrumb-actions" href={back}>
        Products
      </s-link>
      {storefront ? (
        <s-button slot="secondary-actions" href={storefront} target="_blank">
          {product.onlineStoreUrl ? "View in store" : "Preview"}
        </s-button>
      ) : null}
      <s-button
        slot="secondary-actions"
        href={`shopify://admin/products/${product.legacyId}`}
        target="_blank"
      >
        Open in Shopify
      </s-button>

      <ui-save-bar id={SAVE_BAR_ID}>
        <button
          variant="primary"
          onClick={save}
          {...(saving ? { loading: "" } : {})}
        >
          Save
        </button>
        <button onClick={discard}>Discard</button>
      </ui-save-bar>

      <ConfirmModal
        id={CONFIRM_ID}
        heading="Save these changes?"
        confirmLabel="Save"
        tone="neutral"
        onConfirm={submit}
      >
        {consequences.map((line) => (
          <s-paragraph key={line}>{line}</s-paragraph>
        ))}
      </ConfirmModal>

      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="small-300" alignItems="center">
          <s-badge
            {...(product.status === "DRAFT" ? { tone: "info" as const } : {})}
          >
            {STATUS_LABEL[product.status] ?? product.status}
          </s-badge>
          <s-text color="subdued">
            {[
              product.vendor,
              product.productType,
              oneSku ? `SKU ${oneSku}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </s-text>
          {autofill?.status === "ready" && tab !== "attributes" ? (
            <s-link onClick={() => showTab("attributes")}>
              AI suggestion to review
            </s-link>
          ) : null}
          {workspace.issues.length > 0 && tab !== "overview" ? (
            <s-link onClick={() => showTab("overview")}>
              {`${workspace.issues.length} ${workspace.issues.length === 1 ? "thing needs" : "things need"} attention`}
            </s-link>
          ) : null}
        </s-stack>

        {result && !result.ok ? (
          <s-banner tone="critical" heading="Nothing was saved">
            <s-paragraph>{result.message}</s-paragraph>
          </s-banner>
        ) : null}

        <s-box
          paddingBlockEnd="small-300"
          borderWidth="none none small none"
          borderStyle="none none solid none"
          borderColor="subdued"
          accessibilityRole="navigation"
          accessibilityLabel="Product sections"
        >
          <s-stack direction="inline" gap="small-400" alignItems="center">
            {WORKSPACE_TABS.map((entry) =>
              entry.key === tab ? (
                <s-button
                  key={entry.key}
                  variant="secondary"
                  accessibilityLabel={`${entry.label}, current section`}
                >
                  {entry.label}
                </s-button>
              ) : (
                <s-button
                  key={entry.key}
                  variant="tertiary"
                  onClick={() => showTab(entry.key)}
                >
                  {entry.label}
                </s-button>
              ),
            )}
          </s-stack>
        </s-box>

        {tab === "overview" ? (
          <ProductOverview workspace={workspace} onTab={showTab} />
        ) : null}
        {tab === "details" ? (
          <ProductDetails
            workspace={workspace}
            fields={fields}
            errors={fieldErrors}
            dirty={productDirty}
            onChange={(patch) =>
              setFields((current) => ({ ...current, ...patch }))
            }
          />
        ) : null}
        {tab === "attributes" ? (
          <ProductAutofill
            view={autofill}
            available={autofillAvailable}
            variants={workspace.variants}
            dirty={dirty}
            types={autofillTypes}
            currentTypeId={
              workspace.setup.kind === "matched" ? workspace.setup.typeId : null
            }
            nextReview={nextReview}
            reviewWaiting={reviewWaiting}
          />
        ) : null}
        {tab === "attributes" ? (
          <ProductAttributes
            setup={workspace.setup}
            variants={workspace.variants}
            singleVariant={product.hasOnlyDefaultVariant}
            inputs={attributes}
            errors={attributeErrors}
            dirty={dirty}
            onChange={(key: string, value: AttributeInput) =>
              setAttributes((current) => ({ ...current, [key]: value }))
            }
          />
        ) : null}
        {tab === "variants" ? (
          <ProductVariants
            workspace={workspace}
            inputs={variants}
            errors={variantErrors}
            onChange={(variantId, patch) =>
              setVariants((current) => {
                const was = current[variantId];
                return was
                  ? { ...current, [variantId]: { ...was, ...patch } }
                  : current;
              })
            }
          />
        ) : null}
        {tab === "inventory" ? (
          <ProductInventory workspace={workspace} />
        ) : null}
        {tab === "translations" ? (
          <ProductTranslations
            workspace={workspace}
            productId={product.id}
            aiConfigured={aiConfigured}
          />
        ) : null}
        {tab === "activity" ? <Activity items={workspace.activity} /> : null}
      </s-stack>
    </s-page>
  );
}

function Activity({
  items,
}: {
  items: ReturnType<
    typeof useLoaderData<typeof loader>
  >["workspace"]["activity"];
}) {
  return (
    <s-section heading="Activity">
      {items.length === 0 ? (
        <s-text color="subdued">
          Nothing has happened to this product in this app yet.
        </s-text>
      ) : (
        <s-stack direction="block" gap="none">
          {items.map((item, index) => (
            <s-box
              key={item.id}
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
                  gridTemplateColumns="@container (inline-size <= 560px) 1fr, '12rem minmax(0, 1fr)'"
                  gap="small-300"
                >
                  <s-text color="subdued">{formatDateTime(item.at)}</s-text>
                  <s-stack direction="block" gap="small-500">
                    <s-stack
                      direction="inline"
                      gap="small-300"
                      alignItems="center"
                    >
                      <s-text type="strong">{item.title}</s-text>
                      {item.ok ? null : (
                        <s-badge tone="caution">Needs attention</s-badge>
                      )}
                    </s-stack>
                    <s-text color="subdued">{item.text}</s-text>
                  </s-stack>
                </s-grid>
              </s-query-container>
            </s-box>
          ))}
        </s-stack>
      )}
    </s-section>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
