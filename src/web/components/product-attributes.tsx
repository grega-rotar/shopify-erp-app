import { useEffect, useMemo, useState } from "react";
import { useFetcher } from "react-router";

import {
  inputKey,
  isEmptyInput,
  type AssignableType,
  type AttributeField,
  type AttributeInput,
  type AttributeInputs,
} from "~/domain/products/attribute-values";
import { UNGROUPED } from "~/domain/products/workspace";
import { Dropdown } from "~/web/components/dropdown";
import { PageColumns } from "~/web/components/page-columns";
import type { ProductActionResult } from "~/web/lib/product-actions.server";
import type { ProductWorkspace } from "~/web/lib/product-workspace.server";

/**
 * The values the product setup plan asks of this product, entered by hand
 * (docs/attributes.md § On the product page).
 *
 * First what kind of product it is — a type of the plan, chosen here or
 * matched by category or Shopify product type — then that type's
 * attributes, grouped by set, each as the field its Shopify type calls for.
 * Values are part of the page's one form and save with the save bar, to the
 * metafield each attribute names. A field this page cannot write says why
 * and shows what Shopify holds.
 */

const TYPE_MODAL_ID = "product-type-picker";

type Setup = ProductWorkspace["setup"];
type Matched = Extract<Setup, { kind: "matched" }>;

export function ProductAttributes({
  setup,
  variants,
  singleVariant,
  inputs,
  errors,
  dirty,
  onChange,
}: {
  setup: Setup;
  variants: ReadonlyArray<{ variantId: string; title: string }>;
  singleVariant: boolean;
  inputs: AttributeInputs;
  errors: Record<string, string>;
  dirty: boolean;
  onChange: (key: string, value: AttributeInput) => void;
}) {
  if (setup.kind === "unavailable")
    return (
      <s-section heading="Attributes">
        <s-text color="subdued">{setup.message}</s-text>
      </s-section>
    );
  if (setup.kind === "no_plan")
    return (
      <s-section heading="Attributes">
        <s-stack direction="block" gap="base" alignItems="start">
          <s-paragraph>
            No product types are planned yet. Plan the types and the attributes
            each needs in product setup, then choose one here.
          </s-paragraph>
          <s-button href="/app/product-setup">Open product setup</s-button>
        </s-stack>
      </s-section>
    );

  const picker = (
    <TypePicker
      types={setup.types}
      current={setup.kind === "matched" ? setup.typeId : null}
      chosen={setup.kind === "matched" && setup.via === "chosen"}
      dirty={dirty}
    />
  );

  if (setup.kind !== "matched")
    return (
      <>
        {picker}
        <s-section heading="Product type">
          <s-stack direction="block" gap="base" alignItems="start">
            <s-stack direction="block" gap="small-300">
              <s-text type="strong">What kind of product is this?</s-text>
              <s-text color="subdued">
                {setup.kind === "ambiguous"
                  ? `More than one type in your plan fits it: ${setup.candidates.join(", ")}. Choose the one it is, and its attributes appear here to fill in.`
                  : "Choose its type from your plan, and the attributes that type needs appear here to fill in."}
              </s-text>
            </s-stack>
            <s-button
              variant="primary"
              command="--show"
              commandFor={TYPE_MODAL_ID}
              {...(setup.types.length === 0 ? { disabled: true } : {})}
            >
              Choose product type
            </s-button>
            {setup.types.length === 0 ? (
              <s-text color="subdued">
                Your plan has no type products can use yet.
              </s-text>
            ) : null}
          </s-stack>
        </s-section>
      </>
    );

  return (
    <>
      {picker}
      <PageColumns
        aside={
          <Completeness setup={setup} variants={variants} inputs={inputs} />
        }
      >
        <TypeSection setup={setup} />
        {setup.fields.length === 0 ? (
          <s-section>
            <s-text color="subdued">
              The plan asks nothing of this type yet. Attach attributes to it in
              product setup.
            </s-text>
          </s-section>
        ) : (
          <Groups
            setup={setup}
            variants={variants}
            singleVariant={singleVariant}
            inputs={inputs}
            errors={errors}
            onChange={onChange}
          />
        )}
      </PageColumns>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* The type                                                                    */
/* -------------------------------------------------------------------------- */

function TypeSection({ setup }: { setup: Matched }) {
  const parents = setup.path.slice(0, -1);
  const name = setup.path[setup.path.length - 1] ?? "";
  return (
    <s-section>
      <s-grid
        gridTemplateColumns="minmax(0, 1fr) auto"
        gap="base"
        alignItems="center"
      >
        <s-stack direction="block" gap="small-500">
          <s-text color="subdued">Product type</s-text>
          <s-stack direction="inline" gap="small-300" alignItems="center">
            {parents.length > 0 ? (
              <s-text color="subdued">{`${parents.join(" › ")} ›`}</s-text>
            ) : null}
            <s-heading>{name}</s-heading>
          </s-stack>
          <s-text color="subdued">
            {setup.via === "chosen"
              ? "Chosen for this product."
              : setup.via === "category"
                ? "Matched by its Shopify category."
                : "Matched by its Shopify product type."}
          </s-text>
        </s-stack>
        <s-stack direction="inline" gap="small-300">
          <s-button
            variant="tertiary"
            href={`/app/product-setup/types/${setup.typeId}`}
          >
            View in plan
          </s-button>
          <s-button command="--show" commandFor={TYPE_MODAL_ID}>
            Change type
          </s-button>
        </s-stack>
      </s-grid>
    </s-section>
  );
}

function TypePicker({
  types,
  current,
  chosen,
  dirty,
}: {
  types: AssignableType[];
  current: string | null;
  chosen: boolean;
  dirty: boolean;
}) {
  const fetcher = useFetcher<ProductActionResult>();
  const [query, setQuery] = useState("");
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (typeof shopify !== "undefined")
      shopify.toast.show(fetcher.data.message, {
        isError: !fetcher.data.ok,
      });
    if (fetcher.data.ok) {
      const modal = document.getElementById(TYPE_MODAL_ID) as {
        hideOverlay?: () => void;
      } | null;
      modal?.hideOverlay?.();
    }
  }, [fetcher.state, fetcher.data]);

  const shown = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return types.filter((type) => {
      const text = type.path.join(" ").toLowerCase();
      return words.every((word) => text.includes(word));
    });
  }, [types, query]);

  const choose = (typeId: string) =>
    fetcher.submit({ intent: "choose-type", typeId }, { method: "post" });

  return (
    <s-modal id={TYPE_MODAL_ID} heading="Choose product type">
      <s-stack direction="block" gap="base">
        {dirty ? (
          <s-banner tone="warning">
            <s-paragraph>
              Save or discard your changes first. A different type has different
              attributes, so unsaved values would be lost.
            </s-paragraph>
          </s-banner>
        ) : null}
        <s-search-field
          label="Search types"
          labelAccessibilityVisibility="exclusive"
          placeholder="Search types"
          value={query}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
        {shown.length === 0 ? (
          <s-text color="subdued">No type matches.</s-text>
        ) : (
          <s-stack direction="block" gap="none">
            {shown.map((type, index) => {
              const selected = type.id === current;
              const parents = type.path.slice(0, -1);
              return (
                <s-box
                  key={type.id}
                  {...(index > 0
                    ? {
                        borderWidth: "small none none none" as const,
                        borderStyle: "solid none none none" as const,
                        borderColor: "subdued" as const,
                      }
                    : {})}
                >
                  <s-clickable
                    padding="small-200"
                    borderRadius="base"
                    accessibilityLabel={`${type.path.join(", ")}${selected ? ", current type" : ""}`}
                    onClick={() => {
                      if (!selected) choose(type.id);
                    }}
                    {...(dirty || busy ? { disabled: true } : {})}
                  >
                    <s-grid
                      gridTemplateColumns="minmax(0, 1fr) auto"
                      gap="base"
                      alignItems="center"
                    >
                      <s-stack direction="block" gap="small-500">
                        <s-text type="strong">{type.name}</s-text>
                        {parents.length > 0 ? (
                          <s-text color="subdued">{parents.join(" › ")}</s-text>
                        ) : null}
                      </s-stack>
                      {selected ? <s-icon type="check" tone="success" /> : null}
                    </s-grid>
                  </s-clickable>
                </s-box>
              );
            })}
          </s-stack>
        )}
      </s-stack>
      {chosen ? (
        <s-button
          slot="secondary-actions"
          onClick={() => choose("")}
          {...(dirty || busy ? { disabled: true } : {})}
        >
          Match automatically
        </s-button>
      ) : null}
      <s-button
        slot="secondary-actions"
        command="--hide"
        commandFor={TYPE_MODAL_ID}
      >
        Close
      </s-button>
    </s-modal>
  );
}

/* -------------------------------------------------------------------------- */
/* The values                                                                  */
/* -------------------------------------------------------------------------- */

function Groups({
  setup,
  variants,
  singleVariant,
  inputs,
  errors,
  onChange,
}: {
  setup: Matched;
  variants: ReadonlyArray<{ variantId: string; title: string }>;
  singleVariant: boolean;
  inputs: AttributeInputs;
  errors: Record<string, string>;
  onChange: (key: string, value: AttributeInput) => void;
}) {
  const byId = new Map(setup.fields.map((field) => [field.attributeId, field]));
  const rowById = new Map(
    setup.completeness.groups.flatMap((group) =>
      group.rows.map((row) => [row.attributeId, row] as const),
    ),
  );
  return (
    <>
      {setup.completeness.groups.map((group) => {
        const fields = group.rows.flatMap((row) => {
          const field = byId.get(row.attributeId);
          return field ? [field] : [];
        });
        const perProduct = fields.filter(
          (field) => field.scope === "product" || singleVariant,
        );
        const perVariant = fields.filter(
          (field) => field.scope === "variant" && !singleVariant,
        );
        return (
          <s-section
            key={group.name}
            heading={group.name === UNGROUPED ? "Other attributes" : group.name}
          >
            <s-stack direction="block" gap="base">
              {perProduct.length > 0 ? (
                <s-query-container>
                  <s-grid
                    gridTemplateColumns="@container (inline-size <= 560px) 1fr, 'repeat(2, minmax(0, 1fr))'"
                    gap="base"
                    alignItems="start"
                  >
                    {perProduct.map((field) => {
                      const key = inputKey(
                        field.attributeId,
                        field.scope === "variant"
                          ? (variants[0]?.variantId ?? null)
                          : null,
                      );
                      return (
                        <FieldInput
                          key={field.attributeId}
                          field={field}
                          label={field.name}
                          inputKey={key}
                          value={inputs[key]}
                          shown={rowById.get(field.attributeId)?.value ?? null}
                          error={errors[key]}
                          onChange={(value) => onChange(key, value)}
                        />
                      );
                    })}
                  </s-grid>
                </s-query-container>
              ) : null}
              {perVariant.map((field) => (
                <VariantField
                  key={field.attributeId}
                  field={field}
                  variants={variants}
                  inputs={inputs}
                  errors={errors}
                  shown={rowById.get(field.attributeId)?.value ?? null}
                  onChange={onChange}
                />
              ))}
            </s-stack>
          </s-section>
        );
      })}
    </>
  );
}

function VariantField({
  field,
  variants,
  inputs,
  errors,
  shown,
  onChange,
}: {
  field: AttributeField;
  variants: ReadonlyArray<{ variantId: string; title: string }>;
  inputs: AttributeInputs;
  errors: Record<string, string>;
  shown: string | null;
  onChange: (key: string, value: AttributeInput) => void;
}) {
  return (
    <s-box
      padding="base"
      border="base"
      borderRadius="base"
      background="subdued"
    >
      <s-stack direction="block" gap="small-300">
        <s-stack direction="block" gap="small-500">
          <s-text type="strong">{field.name}</s-text>
          <s-text color="subdued">
            {[
              field.required ? "Required on every variant" : "Per variant",
              field.description,
            ]
              .filter(Boolean)
              .join(" · ")}
          </s-text>
        </s-stack>
        {field.edit.kind === "blocked" ? (
          <Blocked reason={field.edit.reason} shown={shown} />
        ) : (
          <s-query-container>
            <s-grid
              gridTemplateColumns="@container (inline-size <= 560px) 1fr, 'repeat(3, minmax(0, 1fr))'"
              gap="small-300"
              alignItems="start"
            >
              {variants.map((variant) => {
                const key = inputKey(field.attributeId, variant.variantId);
                return (
                  <FieldInput
                    key={variant.variantId}
                    field={field}
                    label={variant.title}
                    inputKey={key}
                    value={inputs[key]}
                    shown={null}
                    error={errors[key]}
                    plain
                    onChange={(value) => onChange(key, value)}
                  />
                );
              })}
            </s-grid>
          </s-query-container>
        )}
      </s-stack>
    </s-box>
  );
}

function Blocked({ reason, shown }: { reason: string; shown: string | null }) {
  return (
    <s-stack direction="block" gap="small-500">
      <s-text color={shown ? "base" : "subdued"}>{shown ?? "Not set"}</s-text>
      <s-text color="subdued">{reason}</s-text>
    </s-stack>
  );
}

const BOOLEAN_OPTIONS = [
  { value: "", label: "Not set" },
  { value: "true", label: "Yes" },
  { value: "false", label: "No" },
];

/**
 * One value's field. `plain` drops the description and requirement, for a
 * variant's field under an attribute that already states them.
 */
function FieldInput({
  field,
  label,
  inputKey: name,
  value,
  shown,
  error,
  plain = false,
  onChange,
}: {
  field: AttributeField;
  label: string;
  inputKey: string;
  value: AttributeInput | undefined;
  shown: string | null;
  error: string | undefined;
  plain?: boolean;
  onChange: (value: AttributeInput) => void;
}) {
  const details = plain
    ? undefined
    : [field.required ? "Required" : null, field.description || null]
        .filter(Boolean)
        .join(" · ") || undefined;
  const text = typeof value === "string" ? value : "";
  const common = {
    label,
    ...(details ? { details } : {}),
    ...(error ? { error } : {}),
  };
  const { edit } = field;

  switch (edit.kind) {
    case "blocked":
      return (
        <s-stack direction="block" gap="small-400">
          <s-text type="strong">{label}</s-text>
          <Blocked reason={edit.reason} shown={shown} />
        </s-stack>
      );
    case "text":
      return (
        <s-text-field
          {...common}
          value={text}
          onInput={(event) => onChange(event.currentTarget.value)}
        />
      );
    case "multiline":
      return (
        <s-text-area
          {...common}
          rows={3}
          value={text}
          onInput={(event) => onChange(event.currentTarget.value)}
        />
      );
    case "integer":
    case "decimal":
    case "measurement":
      return (
        <s-number-field
          {...common}
          value={text}
          {...(edit.unit ? { suffix: edit.unit } : {})}
          {...(edit.kind === "integer" ? { step: 1 } : { step: 0.01 })}
          inputMode={edit.kind === "integer" ? "numeric" : "decimal"}
          onInput={(event) => onChange(event.currentTarget.value)}
        />
      );
    case "date":
      return (
        <s-date-field
          {...common}
          value={text}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      );
    case "boolean":
      return (
        <Dropdown
          name={name}
          label={label}
          {...(details ? { details } : {})}
          {...(error ? { error } : {})}
          value={text}
          options={BOOLEAN_OPTIONS}
          onChange={onChange}
        />
      );
    case "choice":
      return (
        <Dropdown
          name={name}
          label={label}
          {...(details ? { details } : {})}
          {...(error ? { error } : {})}
          value={text}
          placeholder="Not set"
          options={[
            { value: "", label: "Not set" },
            ...edit.options.map((option) => ({
              value: option.code,
              label: option.label,
            })),
            // A value stored before the plan had it as an option stays visible.
            ...(text !== "" && !edit.options.some((o) => o.code === text)
              ? [{ value: text, label: `${text} (not an option)` }]
              : []),
          ]}
          onChange={onChange}
        />
      );
    case "choices":
      return (
        <s-choice-list
          {...common}
          name={name}
          multiple
          values={Array.isArray(value) ? value : []}
          onChange={(event) => onChange([...event.currentTarget.values])}
        >
          {edit.options.map((option) => (
            <s-choice key={option.code} value={option.code}>
              {option.label}
            </s-choice>
          ))}
        </s-choice-list>
      );
  }
}

/* -------------------------------------------------------------------------- */
/* Completeness                                                               */
/* -------------------------------------------------------------------------- */

function Completeness({
  setup,
  variants,
  inputs,
}: {
  setup: Matched;
  variants: ReadonlyArray<{ variantId: string }>;
  inputs: AttributeInputs;
}) {
  // Counted from what is on the page, so it moves as values are entered.
  const stateById = new Map(
    setup.completeness.groups.flatMap((group) =>
      group.rows.map((row) => [row.attributeId, row.state] as const),
    ),
  );
  const required = setup.fields.filter((field) => field.required);
  const missing = required.filter((field) => {
    if (field.edit.kind === "blocked")
      return stateById.get(field.attributeId) !== "set";
    if (field.scope === "variant")
      return variants.some((variant) =>
        isEmptyInput(inputs[inputKey(field.attributeId, variant.variantId)]),
      );
    return isEmptyInput(inputs[inputKey(field.attributeId, null)]);
  });
  const filled = setup.fields.filter((field) =>
    field.scope === "variant"
      ? field.edit.kind === "blocked"
        ? stateById.get(field.attributeId) === "set"
        : variants.every(
            (variant) =>
              !isEmptyInput(
                inputs[inputKey(field.attributeId, variant.variantId)],
              ),
          )
      : field.edit.kind === "blocked"
        ? stateById.get(field.attributeId) === "set"
        : !isEmptyInput(inputs[inputKey(field.attributeId, null)]),
  ).length;

  return (
    <s-section heading="Completeness">
      <s-stack direction="block" gap="base">
        <s-stack direction="block" gap="small-400">
          <s-stack direction="inline" gap="small-300" alignItems="center">
            <s-text type="strong">
              {required.length === 0
                ? "Nothing is required"
                : `${required.length - missing.length} of ${required.length} required`}
            </s-text>
            {required.length > 0 ? (
              missing.length === 0 ? (
                <s-badge tone="success">Complete</s-badge>
              ) : (
                <s-badge tone="warning">{`${missing.length} missing`}</s-badge>
              )
            ) : null}
          </s-stack>
          <s-text color="subdued">
            {`${filled} of ${setup.fields.length} ${setup.fields.length === 1 ? "attribute" : "attributes"} filled in`}
          </s-text>
        </s-stack>
        {missing.length > 0 ? (
          <s-stack direction="block" gap="small-400">
            <s-text color="subdued">Still needed</s-text>
            <s-unordered-list>
              {missing.map((field) => (
                <s-list-item key={field.attributeId}>{field.name}</s-list-item>
              ))}
            </s-unordered-list>
          </s-stack>
        ) : null}
        <s-divider />
        <s-text color="subdued">
          Values save to the product’s Shopify metafields with the save bar,
          each under the field its attribute names in the plan.
        </s-text>
        {!setup.variantDetailsRead ? (
          <s-text color="subdued">
            Variant values could not be read just now, so they cannot be changed
            until the page is reloaded.
          </s-text>
        ) : null}
      </s-stack>
    </s-section>
  );
}
