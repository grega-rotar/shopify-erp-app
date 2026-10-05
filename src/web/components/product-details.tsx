import { useState } from "react";

import {
  LIMITS,
  isProtectedTag,
  type ProductFieldErrors,
  type ProductFields,
} from "~/domain/products/workspace";
import { Dropdown } from "~/web/components/dropdown";
import {
  HtmlEditor,
  HtmlViewSwitch,
  type HtmlView,
} from "~/web/components/html-editor";
import { PageColumns } from "~/web/components/page-columns";
import { needsSourceEditing } from "~/web/lib/html";
import type { ProductWorkspace } from "~/web/lib/product-workspace.server";

/**
 * The product's own information, edited here instead of in Shopify's
 * product editor (docs/architecture.md § Product workspace): what it is
 * called and how it is described, how search engines list it, and its
 * pictures. The values the product setup plan asks for are the Attributes
 * tab (`product-attributes.tsx`). Organisation — status,
 * tags, category, collections — is the column beside it.
 *
 * Every field is state the page owns; the save bar saves them together.
 * What another system writes says so under the field, once, and only the
 * source warning grows louder while there are unsaved edits
 * (docs/ui-conventions.md § Overwrite-risk pattern).
 */

const STATUS_OPTIONS = [
  { value: "ACTIVE", label: "Active" },
  { value: "DRAFT", label: "Draft" },
  { value: "ARCHIVED", label: "Archived" },
];

export function ProductDetails({
  workspace,
  fields,
  errors,
  dirty,
  onChange,
}: {
  workspace: ProductWorkspace;
  fields: ProductFields;
  errors: ProductFieldErrors;
  dirty: boolean;
  onChange: (patch: Partial<ProductFields>) => void;
}) {
  const { product, media, source, metakocka } = workspace;
  const sourceOnly = needsSourceEditing(workspace.fields.descriptionHtml);
  const [view, setView] = useState<HtmlView>(sourceOnly ? "source" : "rich");

  return (
    <PageColumns
      aside={
        <s-stack direction="block" gap="base">
          <Organisation
            workspace={workspace}
            fields={fields}
            errors={errors}
            onChange={onChange}
          />
        </s-stack>
      }
    >
      {source && dirty ? (
        <s-banner tone="warning" heading="A source updates this product">
          <s-paragraph>
            {`The next run of ${source.name ?? "its export portal source"} may replace what you change here. Change it in the source’s own data to keep it.`}
          </s-paragraph>
        </s-banner>
      ) : null}

      <s-section heading="Product information">
        <s-stack direction="block" gap="base">
          <s-stack direction="block" gap="small-300">
            <s-text-field
              label="Title"
              value={fields.title}
              maxLength={LIMITS.title}
              onInput={(event) =>
                onChange({ title: event.currentTarget.value })
              }
              {...(errors.title ? { error: errors.title } : {})}
            />
            {metakocka.nameSync && metakocka.namePolicy === "always" ? (
              <s-text color="subdued">
                MetaKocka product names are rebuilt from this title on each
                product sync.
              </s-text>
            ) : null}
          </s-stack>

          <s-stack direction="block" gap="small-300">
            <s-grid
              gridTemplateColumns="1fr auto"
              alignItems="center"
              gap="base"
            >
              <s-text type="strong">Description</s-text>
              <HtmlViewSwitch
                view={view}
                onChange={setView}
                richDisabled={sourceOnly}
                disabledReason="This description holds an embed or a table, which rich text editing would rewrite."
              />
            </s-grid>
            {view === "rich" ? (
              <HtmlEditor
                label="Description"
                value={fields.descriptionHtml}
                onChange={(html) => onChange({ descriptionHtml: html })}
                blockSize="320px"
                placeholder="Describe the product for shoppers."
                busy={false}
              />
            ) : (
              <s-text-area
                label="Description HTML"
                labelAccessibilityVisibility="exclusive"
                rows={14}
                value={fields.descriptionHtml}
                onInput={(event) =>
                  onChange({ descriptionHtml: event.currentTarget.value })
                }
              />
            )}
          </s-stack>

          <s-query-container>
            <s-grid
              gridTemplateColumns="@container (inline-size <= 560px) 1fr, '1fr 1fr'"
              gap="base"
            >
              <s-text-field
                label="Vendor"
                value={fields.vendor}
                onInput={(event) =>
                  onChange({ vendor: event.currentTarget.value })
                }
                {...(errors.vendor ? { error: errors.vendor } : {})}
              />
              <s-text-field
                label="Product type"
                value={fields.productType}
                details="Shopify’s own grouping, used in filters and collections."
                onInput={(event) =>
                  onChange({ productType: event.currentTarget.value })
                }
                {...(errors.productType ? { error: errors.productType } : {})}
              />
            </s-grid>
          </s-query-container>
        </s-stack>
      </s-section>

      <s-section heading="Search engine listing">
        <s-stack direction="block" gap="base">
          <s-text-field
            label="Page title"
            value={fields.seoTitle}
            placeholder={fields.title}
            details={`${fields.seoTitle.length} of 70 characters used. Empty uses the title.`}
            onInput={(event) =>
              onChange({ seoTitle: event.currentTarget.value })
            }
            {...(errors.seoTitle ? { error: errors.seoTitle } : {})}
          />
          <s-text-area
            label="Meta description"
            rows={3}
            value={fields.seoDescription}
            details={`${fields.seoDescription.length} of ${LIMITS.seoDescription} characters used. Empty uses the start of the description.`}
            onInput={(event) =>
              onChange({ seoDescription: event.currentTarget.value })
            }
            {...(errors.seoDescription ? { error: errors.seoDescription } : {})}
          />
          <s-text color="subdued">{`Address: /products/${product.handle}`}</s-text>
        </s-stack>
      </s-section>

      <MediaSection media={media} legacyId={product.legacyId} />
    </PageColumns>
  );
}

function Organisation({
  workspace,
  fields,
  errors,
  onChange,
}: {
  workspace: ProductWorkspace;
  fields: ProductFields;
  errors: ProductFieldErrors;
  onChange: (patch: Partial<ProductFields>) => void;
}) {
  const { product } = workspace;
  const [draft, setDraft] = useState("");
  const editable = fields.tags.filter((tag) => !isProtectedTag(tag));
  const protectedTags = fields.tags.filter(isProtectedTag);

  const add = () => {
    const parts = draft
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
    if (parts.length === 0) return;
    const known = new Set(fields.tags.map((tag) => tag.toLowerCase()));
    onChange({
      tags: [
        ...fields.tags,
        ...parts.filter((tag) => !known.has(tag.toLowerCase())),
      ],
    });
    setDraft("");
  };

  return (
    <>
      <s-section heading="Status">
        <s-stack direction="block" gap="small-300">
          <Dropdown
            name="status"
            label="Status"
            hideLabel
            value={fields.status}
            options={STATUS_OPTIONS}
            onChange={(value) => {
              if (
                value === "ACTIVE" ||
                value === "DRAFT" ||
                value === "ARCHIVED"
              )
                onChange({ status: value });
            }}
            {...(errors.status ? { error: errors.status } : {})}
          />
          <s-text color="subdued">
            {fields.status === "ACTIVE"
              ? "Shoppers can find it on the channels it is published to."
              : fields.status === "DRAFT"
                ? "Hidden from every channel until it is set active."
                : "Hidden, and kept out of the admin’s product lists."}
          </s-text>
        </s-stack>
      </s-section>

      <s-section heading="Organisation">
        <s-stack direction="block" gap="base">
          <s-stack direction="block" gap="small-300">
            <div
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  add();
                }
              }}
            >
              <s-grid
                gridTemplateColumns="1fr auto"
                gap="small-300"
                alignItems="end"
              >
                <s-text-field
                  label="Tags"
                  value={draft}
                  placeholder="Add a tag"
                  onInput={(event) => setDraft(event.currentTarget.value)}
                  {...(errors.tags ? { error: errors.tags } : {})}
                />
                <s-button
                  onClick={add}
                  {...(draft.trim() === "" ? { disabled: true } : {})}
                >
                  Add
                </s-button>
              </s-grid>
            </div>
            {editable.length > 0 ? (
              <s-stack direction="inline" gap="small-300">
                {editable.map((tag) => (
                  <s-chip
                    key={tag}
                    removable
                    accessibilityLabel={`Remove tag ${tag}`}
                    onRemove={() =>
                      onChange({ tags: fields.tags.filter((t) => t !== tag) })
                    }
                  >
                    {tag}
                  </s-chip>
                ))}
              </s-stack>
            ) : null}
            {protectedTags.length > 0 ? (
              <s-text color="subdued">
                {protectedTags.length === 1
                  ? "1 more tag belongs to the export portal, which reads it; it stays as it is."
                  : `${protectedTags.length} more tags belong to the export portal, which reads them; they stay as they are.`}
              </s-text>
            ) : null}
          </s-stack>

          <s-divider />

          <s-stack direction="block" gap="small-400">
            <s-text type="strong">Category</s-text>
            <s-text color={product.category ? "base" : "subdued"}>
              {product.category?.fullName ?? "No category"}
            </s-text>
          </s-stack>

          <s-stack direction="block" gap="small-400">
            <s-text type="strong">Collections</s-text>
            <s-text color={product.collections.length > 0 ? "base" : "subdued"}>
              {product.collections.length > 0
                ? product.collections.map((c) => c.title).join(", ")
                : "In no collection"}
            </s-text>
          </s-stack>

          <s-link
            href={`shopify://admin/products/${product.legacyId}`}
            target="_blank"
          >
            Change category or collections in Shopify
          </s-link>
        </s-stack>
      </s-section>
    </>
  );
}

function MediaSection({
  media,
  legacyId,
}: {
  media: ProductWorkspace["media"];
  legacyId: string;
}) {
  const images = media.items;
  return (
    <s-section heading="Media">
      <s-stack direction="block" gap="base">
        {images.length === 0 ? (
          <s-text color="subdued">No pictures or videos yet.</s-text>
        ) : (
          <s-query-container>
            <s-grid
              gridTemplateColumns="@container (inline-size <= 480px) 'repeat(3, minmax(0, 1fr))', 'repeat(6, minmax(0, 1fr))'"
              gap="small-300"
            >
              {images.map((item) => (
                <s-stack key={item.id} direction="block" gap="small-500">
                  <s-box
                    border="base"
                    borderRadius="base"
                    overflow="hidden"
                    inlineSize="100%"
                    blockSize="auto"
                  >
                    <div
                      style={{
                        aspectRatio: "1 / 1",
                        display: "grid",
                        placeItems: "center",
                      }}
                    >
                      {item.url ? (
                        <s-image
                          src={item.url}
                          alt={item.alt ?? ""}
                          inlineSize="fill"
                          aspectRatio="1/1"
                          objectFit="contain"
                          loading="lazy"
                        />
                      ) : (
                        <s-text color="subdued">
                          {item.kind.toLowerCase()}
                        </s-text>
                      )}
                    </div>
                  </s-box>
                  <s-text color="subdued">
                    {item.featured
                      ? "Main"
                      : item.alt
                        ? item.alt
                        : "No alt text"}
                  </s-text>
                </s-stack>
              ))}
            </s-grid>
          </s-query-container>
        )}
        <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
          <s-text color="subdued">
            {media.count > images.length
              ? `Showing ${images.length} of ${media.count}.`
              : media.count === 1
                ? "1 item."
                : `${media.count} items.`}
          </s-text>
          <s-button
            href={`shopify://admin/products/${legacyId}`}
            target="_blank"
          >
            Manage media in Shopify
          </s-button>
        </s-grid>
      </s-stack>
    </s-section>
  );
}
