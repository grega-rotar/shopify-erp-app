import { activeAttributes, pathOf } from "~/domain/attributes/resolve";
import type {
  AttributeSchema,
  DataType,
  Scope,
  ValueList,
} from "~/domain/attributes/types";
import { REVIEW_TAG, SOURCE_TAG_PREFIX } from "~/domain/export-portal/review";
import type { MetafieldMap } from "~/domain/sales/types";
import { classifyField, isTranslatableField } from "~/domain/translations/plan";
import type {
  ExistingTranslation,
  FieldState,
  OwnershipRecord,
  SourceField,
} from "~/domain/translations/types";

/**
 * The product workspace's rules (docs/architecture.md § Product workspace):
 * which product type of the plan a product is, how complete its attributes
 * are, what an edit may change and whether it is valid, who writes a
 * location's stock, where each language stands, and what needs a person.
 *
 * Pure: every input is passed in, including the hash function ownership is
 * compared with, so the page and its tests reach the same answers.
 */

/* -------------------------------------------------------------------------- */
/* Which product type                                                         */
/* -------------------------------------------------------------------------- */

export type TypeMatch =
  | {
      kind: "matched";
      typeId: string;
      via: "chosen" | "category" | "product_type";
      path: string[];
    }
  | { kind: "ambiguous"; via: "category" | "product_type"; typeIds: string[] }
  | { kind: "none" };

function norm(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/**
 * The product type of the plan this product is.
 *
 * The plan has no product assignments (docs/attributes.md): it names a
 * Shopify category per type, and a type has a name. So a product is the
 * assignable type whose Shopify category is the product's category —
 * its name or its full path — and failing that, the one whose name or path
 * is the product's Shopify product type. Two candidates is not a guess this
 * makes; it says so and the page shows no attributes.
 *
 * A type a person chose for the product outranks both, as long as the plan
 * still has it as a type products can use.
 */
export function typeForProduct(
  schema: AttributeSchema,
  product: {
    categoryName: string | null;
    categoryFullName: string | null;
    productType: string | null;
    chosenTypeId?: string | null;
  },
): TypeMatch {
  const leaves = schema.types.filter((type) => type.leaf);

  const chosen = product.chosenTypeId
    ? leaves.find((type) => type.id === product.chosenTypeId)
    : undefined;
  if (chosen)
    return {
      kind: "matched",
      typeId: chosen.id,
      via: "chosen",
      path: pathOf(schema, chosen.id),
    };

  const category = [
    norm(product.categoryName),
    norm(product.categoryFullName),
  ].filter(Boolean);
  if (category.length > 0) {
    const byCategory = leaves.filter(
      (type) =>
        norm(type.shopifyCategory) !== "" &&
        category.includes(norm(type.shopifyCategory)),
    );
    if (byCategory.length === 1 && byCategory[0])
      return {
        kind: "matched",
        typeId: byCategory[0].id,
        via: "category",
        path: pathOf(schema, byCategory[0].id),
      };
    if (byCategory.length > 1)
      return {
        kind: "ambiguous",
        via: "category",
        typeIds: byCategory.map((type) => type.id),
      };
  }

  const productType = norm(product.productType);
  if (productType !== "") {
    const byName = leaves.filter(
      (type) =>
        norm(type.name) === productType ||
        norm(pathOf(schema, type.id).join(" > ")) === productType,
    );
    if (byName.length === 1 && byName[0])
      return {
        kind: "matched",
        typeId: byName[0].id,
        via: "product_type",
        path: pathOf(schema, byName[0].id),
      };
    if (byName.length > 1)
      return {
        kind: "ambiguous",
        via: "product_type",
        typeIds: byName.map((type) => type.id),
      };
  }
  return { kind: "none" };
}

/* -------------------------------------------------------------------------- */
/* Attribute values                                                           */
/* -------------------------------------------------------------------------- */

export type AttributeState = "set" | "missing" | "unmapped";

export interface AttributeValueRow {
  attributeId: string;
  name: string;
  required: boolean;
  scope: Scope;
  dataType: DataType;
  /** The value as a person reads it; null when there is none. */
  value: string | null;
  /** Variant-level: how many of the product's variants carry a value. */
  variantsWithValue: number | null;
  state: AttributeState;
}

export interface AttributeGroup {
  name: string;
  rows: AttributeValueRow[];
}

export interface AttributeCompleteness {
  groups: AttributeGroup[];
  requiredTotal: number;
  requiredComplete: number;
  /** Names of required attributes with no value, in display order. */
  missingRequired: string[];
  /** Attributes the plan has not given a Shopify field yet. */
  unmapped: number;
}

/** Heading for attributes that belong to no set. */
export const UNGROUPED = "Other details";

function measurementText(value: string): string | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      parsed &&
      typeof parsed === "object" &&
      "value" in parsed &&
      "unit" in parsed
    ) {
      const { value: amount, unit } = parsed as {
        value: unknown;
        unit: unknown;
      };
      return `${String(amount)} ${String(unit).toLowerCase().replace(/_/g, " ")}`;
    }
  } catch {
    return null;
  }
  return null;
}

function listText(value: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : null;
  } catch {
    return null;
  }
}

/**
 * A metafield value as a person reads it: a boolean as Yes or No, a
 * measurement with its unit, a list joined, a select's code as its label.
 * A reference is a record elsewhere this page cannot name, so it is said
 * to be set rather than shown as an id.
 */
export function displayMetafield(
  entry: { type: string; value: string },
  options: { unit?: string; valueList?: ValueList | null } = {},
): string | null {
  const { type, value } = entry;
  if (value.trim() === "") return null;
  const label = (code: string) =>
    options.valueList?.items.find((item) => item.code === code)?.en ?? code;

  if (type === "boolean") return value === "true" ? "Yes" : "No";
  if (type.startsWith("list.")) {
    const items = listText(value);
    if (!items) return value;
    if (items.length === 0) return null;
    if (type.endsWith("_reference")) return `${items.length} linked`;
    const inner = type.slice("list.".length);
    return items
      .map((item) =>
        ["dimension", "volume", "weight"].includes(inner)
          ? (measurementText(item) ?? item)
          : label(item),
      )
      .join(", ");
  }
  if (type.endsWith("_reference")) return "Linked";
  if (type === "dimension" || type === "volume" || type === "weight")
    return measurementText(value) ?? value;
  if (type === "rich_text_field") return "Set";
  if (type === "json") return "Set";
  if ((type === "number_integer" || type === "number_decimal") && options.unit)
    return `${value} ${options.unit}`;
  return label(value);
}

/**
 * The type's active attributes (inheritance, overrides and exclusions as
 * the plan resolves them) against the metafields the product and its
 * variants hold, grouped by set in the plan's order.
 */
export function attributeCompleteness(
  schema: AttributeSchema,
  typeId: string,
  product: MetafieldMap,
  variants: readonly MetafieldMap[],
): AttributeCompleteness {
  const resolved = activeAttributes(schema, typeId);
  const setName = new Map(schema.sets.map((set) => [set.id, set.name]));
  const setOrder = new Map(schema.sets.map((set, index) => [set.id, index]));
  const lists = new Map(schema.valueLists.map((list) => [list.id, list]));

  const byGroup = new Map<string, AttributeValueRow[]>();
  let requiredTotal = 0;
  let requiredComplete = 0;
  let unmapped = 0;
  const missingRequired: string[] = [];

  for (const row of resolved) {
    const { attribute } = row;
    const key = attribute.key.trim();
    const valueList = attribute.valueListId
      ? (lists.get(attribute.valueListId) ?? null)
      : null;
    const format = (entry: { type: string; value: string } | undefined) =>
      entry
        ? displayMetafield(entry, { unit: attribute.unit, valueList })
        : null;

    let value: string | null = null;
    let variantsWithValue: number | null = null;
    let state: AttributeState;
    if (key === "") {
      state = "unmapped";
      unmapped += 1;
    } else if (attribute.scope === "variant") {
      const values = variants.map((map) => format(map[key]));
      variantsWithValue = values.filter((v) => v !== null).length;
      const distinct = [
        ...new Set(values.filter((v): v is string => v !== null)),
      ];
      value =
        distinct.length === 0
          ? null
          : distinct.length <= 3
            ? distinct.join(", ")
            : `${distinct.length} values`;
      state =
        variants.length > 0 && variantsWithValue === variants.length
          ? "set"
          : "missing";
    } else {
      value = format(product[key]);
      state = value === null ? "missing" : "set";
    }

    if (row.required) {
      requiredTotal += 1;
      if (state === "set") requiredComplete += 1;
      else missingRequired.push(attribute.name);
    }

    const group = attribute.setId ?? "";
    const list = byGroup.get(group) ?? [];
    list.push({
      attributeId: attribute.id,
      name: attribute.name,
      required: row.required,
      scope: attribute.scope,
      dataType: attribute.dataType,
      value,
      variantsWithValue,
      state,
    });
    byGroup.set(group, list);
  }

  const groups = [...byGroup.entries()]
    .sort(
      ([a], [b]) =>
        (a === "" ? Infinity : (setOrder.get(a) ?? Infinity)) -
        (b === "" ? Infinity : (setOrder.get(b) ?? Infinity)),
    )
    .map(([id, rows]) => ({
      name: id === "" ? UNGROUPED : (setName.get(id) ?? UNGROUPED),
      rows,
    }));

  return { groups, requiredTotal, requiredComplete, missingRequired, unmapped };
}

/* -------------------------------------------------------------------------- */
/* Editing the product                                                        */
/* -------------------------------------------------------------------------- */

export const PRODUCT_STATUSES = ["ACTIVE", "DRAFT", "ARCHIVED"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export function isProductStatus(value: string): value is ProductStatus {
  return (PRODUCT_STATUSES as readonly string[]).includes(value);
}

/** What the workspace edits on the product itself. */
export interface ProductFields {
  title: string;
  descriptionHtml: string;
  vendor: string;
  productType: string;
  status: ProductStatus;
  tags: string[];
  seoTitle: string;
  seoDescription: string;
}

/** Only the fields that changed; tags travel separately as additions and removals. */
export type ProductChange = Partial<Omit<ProductFields, "tags">>;

export type ProductFieldErrors = Partial<Record<keyof ProductFields, string>>;

/** Shopify's own limits, checked here so the message is next to the field. */
export const LIMITS = {
  title: 255,
  vendor: 255,
  productType: 255,
  tag: 255,
  tags: 250,
  seoTitle: 255,
  seoDescription: 320,
} as const;

/** Tags the export portal reads, which only the portal and review approval change. */
export function isProtectedTag(tag: string): boolean {
  return tag === REVIEW_TAG || tag.startsWith(SOURCE_TAG_PREFIX);
}

export function validateProduct(fields: ProductFields): ProductFieldErrors {
  const errors: ProductFieldErrors = {};
  const title = fields.title.trim();
  if (title === "")
    errors.title =
      "Enter a title. Shoppers see it everywhere the product is listed.";
  else if (title.length > LIMITS.title)
    errors.title = `Shorten the title to ${LIMITS.title} characters or fewer.`;
  if (fields.vendor.trim().length > LIMITS.vendor)
    errors.vendor = `Shorten the vendor to ${LIMITS.vendor} characters or fewer.`;
  if (fields.productType.trim().length > LIMITS.productType)
    errors.productType = `Shorten the product type to ${LIMITS.productType} characters or fewer.`;
  if (!isProductStatus(fields.status))
    errors.status = "Choose Active, Draft or Archived.";
  if (fields.tags.length > LIMITS.tags)
    errors.tags = `A product can have up to ${LIMITS.tags} tags.`;
  else if (fields.tags.some((tag) => tag.includes(",")))
    errors.tags = "A tag cannot contain a comma. Add each tag on its own.";
  else if (fields.tags.some((tag) => tag.length > LIMITS.tag))
    errors.tags = `Shorten each tag to ${LIMITS.tag} characters or fewer.`;
  if (fields.seoTitle.trim().length > LIMITS.seoTitle)
    errors.seoTitle = `Shorten the page title to ${LIMITS.seoTitle} characters or fewer.`;
  if (fields.seoDescription.trim().length > LIMITS.seoDescription)
    errors.seoDescription = `Shorten the meta description to ${LIMITS.seoDescription} characters or fewer.`;
  return errors;
}

/** Tags as a person typed them: trimmed, blanks and repeats dropped, order kept. */
export function cleanTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    if (tag === "" || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  return out;
}

/**
 * What a save changes: the scalar fields that differ, and the tags to add
 * and remove. A protected tag is never removed, whatever the form says.
 */
export function productChanges(
  saved: ProductFields,
  next: ProductFields,
): { change: ProductChange; add: string[]; remove: string[] } {
  const change: ProductChange = {};
  if (next.title.trim() !== saved.title) change.title = next.title.trim();
  if (next.descriptionHtml !== saved.descriptionHtml)
    change.descriptionHtml = next.descriptionHtml;
  if (next.vendor.trim() !== saved.vendor) change.vendor = next.vendor.trim();
  if (next.productType.trim() !== saved.productType)
    change.productType = next.productType.trim();
  if (next.status !== saved.status) change.status = next.status;
  if (next.seoTitle.trim() !== saved.seoTitle)
    change.seoTitle = next.seoTitle.trim();
  if (next.seoDescription.trim() !== saved.seoDescription)
    change.seoDescription = next.seoDescription.trim();

  const had = new Set(saved.tags.map((tag) => tag.toLowerCase()));
  const has = new Set(next.tags.map((tag) => tag.toLowerCase()));
  const add = next.tags.filter((tag) => !had.has(tag.toLowerCase()));
  const remove = saved.tags.filter(
    (tag) => !has.has(tag.toLowerCase()) && !isProtectedTag(tag),
  );
  return { change, add, remove };
}

/**
 * The fields a save changed that Shopify has changed since the page read
 * them. Saving over those would discard someone else's edit, so the save
 * is refused and the page read again.
 */
export function staleFields(
  pageRead: ProductFields,
  live: ProductFields,
  change: ProductChange,
  tagsTouched: boolean,
): Array<keyof ProductFields> {
  const stale: Array<keyof ProductFields> = [];
  for (const key of Object.keys(change) as Array<keyof ProductChange>)
    if (pageRead[key] !== live[key]) stale.push(key);
  if (
    tagsTouched &&
    [...pageRead.tags].sort().join("\n") !== [...live.tags].sort().join("\n")
  )
    stale.push("tags");
  return stale;
}

/* -------------------------------------------------------------------------- */
/* Editing variants                                                           */
/* -------------------------------------------------------------------------- */

/** A live sale campaign's hold on a variant's price (docs/sale-campaigns.md). */
export interface PriceHold {
  campaignId: string;
  campaignName: string;
  state: string;
}

export interface VariantFields {
  variantId: string;
  priceMinor: number;
  compareAtMinor: number | null;
  sku: string | null;
  barcode: string | null;
}

/** A variant edit as the form sends it: money as typed. */
export interface VariantInput {
  variantId: string;
  price: string;
  compareAt: string;
  sku: string;
  barcode: string;
}

export interface VariantChange {
  variantId: string;
  priceMinor?: number;
  compareAtMinor?: number | null;
  sku?: string;
  barcode?: string;
}

export type VariantFieldErrors = Partial<
  Record<"price" | "compareAt" | "sku" | "barcode", string>
>;

/** The largest price this form accepts, in minor units. */
const MAX_PRICE_MINOR = 100_000_000_00;

/**
 * Money as typed, in minor units: "1199", "1199.5", "1.199,50" and
 * "1 199,50" all read; anything else is null. A comma followed by exactly
 * one or two digits at the end is the decimal separator.
 */
export function parseMoney(text: string): number | null {
  let value = text.trim().replace(/[\s\u00a0\u20ac$\u00a3]/g, "");
  if (value === "") return null;
  const decimalComma = /,\d{1,2}$/.test(value);
  value = decimalComma
    ? value.replace(/\./g, "").replace(",", ".")
    : value.replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return null;
  const [whole = "0", fraction = ""] = value.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

/** Minor units as the form shows them, with a point: 219900 → "2199.00". */
export function moneyInput(minor: number | null): string {
  if (minor === null) return "";
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;
}

/**
 * Reads the variant form against what was saved and what holds a price.
 *
 * A variant a live campaign holds keeps its price and compare-at: the
 * campaign recorded what to put back and expects to find its sale price,
 * so an edit here would either be undone by the campaign or turn the
 * variant into a decision someone has to make. That is refused here and
 * again on the server, whatever the form sent.
 */
export function variantChanges(
  saved: readonly VariantFields[],
  inputs: readonly VariantInput[],
  holds: ReadonlyMap<string, PriceHold>,
): { changes: VariantChange[]; errors: Record<string, VariantFieldErrors> } {
  const byId = new Map(saved.map((variant) => [variant.variantId, variant]));
  const changes: VariantChange[] = [];
  const errors: Record<string, VariantFieldErrors> = {};

  for (const input of inputs) {
    const was = byId.get(input.variantId);
    if (!was) continue;
    const problems: VariantFieldErrors = {};
    const change: VariantChange = { variantId: input.variantId };

    const price = parseMoney(input.price);
    const compareAt =
      input.compareAt.trim() === "" ? null : parseMoney(input.compareAt);
    const priceValid = price !== null && price <= MAX_PRICE_MINOR;
    const compareValid =
      input.compareAt.trim() === "" ||
      (compareAt !== null && compareAt <= MAX_PRICE_MINOR);

    if (!priceValid) problems.price = "Enter a price such as 1199.00.";
    if (!compareValid)
      problems.compareAt =
        "Enter a compare-at price such as 1399.00, or leave it empty.";

    const priceChanged = priceValid && price !== was.priceMinor;
    const compareChanged = compareValid && compareAt !== was.compareAtMinor;
    const hold = holds.get(input.variantId);
    if (hold && (priceChanged || compareChanged)) {
      const message = `${hold.campaignName} manages this price. Change it from the campaign.`;
      if (priceChanged) problems.price = message;
      if (compareChanged) problems.compareAt = message;
    }

    if (
      priceValid &&
      compareValid &&
      compareAt !== null &&
      price !== null &&
      (priceChanged || compareChanged) &&
      compareAt <= price
    )
      problems.compareAt =
        "Make the compare-at price higher than the price, or leave it empty.";

    const sku = input.sku.trim();
    const barcode = input.barcode.trim();
    if (sku.length > 255)
      problems.sku = "Shorten the SKU to 255 characters or fewer.";
    if (barcode.length > 255)
      problems.barcode = "Shorten the barcode to 255 characters or fewer.";

    if (Object.keys(problems).length > 0) {
      errors[input.variantId] = problems;
      continue;
    }
    if (priceChanged && price !== null) change.priceMinor = price;
    if (compareChanged) change.compareAtMinor = compareAt;
    if (sku !== (was.sku ?? "")) change.sku = sku;
    if (barcode !== (was.barcode ?? "")) change.barcode = barcode;
    if (Object.keys(change).length > 1) changes.push(change);
  }
  return { changes, errors };
}

/* -------------------------------------------------------------------------- */
/* Who writes a location's stock                                              */
/* -------------------------------------------------------------------------- */

export type StockWriter =
  | { kind: "fulfillment_service"; service: string }
  | { kind: "metakocka"; warehouse: string | null; paused: boolean }
  | { kind: "shopify"; warehouse: string | null; paused: boolean }
  | { kind: "none" };

/**
 * Which system sets the numbers at one location (docs/BUILD_SPEC.md §7):
 * a fulfilment service's own app, MetaKocka through this app's stock sync,
 * Shopify with this app copying it to MetaKocka, or nobody this app knows of.
 */
export function stockWriterFor(
  location: { fulfillmentServiceName: string | null },
  source: {
    stockDirection: string;
    enabled: boolean;
    warehouseName: string | null;
  } | null,
): StockWriter {
  if (location.fulfillmentServiceName)
    return {
      kind: "fulfillment_service",
      service: location.fulfillmentServiceName,
    };
  if (source?.stockDirection === "mk_to_shopify")
    return {
      kind: "metakocka",
      warehouse: source.warehouseName,
      paused: !source.enabled,
    };
  if (source?.stockDirection === "shopify_to_mk")
    return {
      kind: "shopify",
      warehouse: source.warehouseName,
      paused: !source.enabled,
    };
  return { kind: "none" };
}

/* -------------------------------------------------------------------------- */
/* Translations of this product                                               */
/* -------------------------------------------------------------------------- */

export type FieldStatus = FieldState | "kept";

export interface LocaleStatus {
  locale: string;
  /** Fields a translation is owed for: translatable and not kept. */
  owed: number;
  missing: number;
  outdated: number;
  /** Of the owed, how many hold a current translation, as a whole percent. */
  percent: number;
  fields: Array<{ key: string; state: FieldStatus }>;
}

/**
 * Where each language stands on this product, counted the way coverage
 * counts (docs/translations.md § Coverage): prose fields only, a kept field
 * owes nothing, and each field's state is the one the editor shows.
 */
export function localeStatuses(input: {
  fields: readonly SourceField[];
  translations: ReadonlyMap<string, readonly ExistingTranslation[]>;
  ownership: readonly OwnershipRecord[];
  locales: readonly string[];
  kept: (locale: string) => ReadonlySet<string>;
  hash: (value: string) => string;
}): LocaleStatus[] {
  const fields = input.fields.filter(isTranslatableField);
  return input.locales.map((locale) => {
    const kept = input.kept(locale);
    const existing = new Map(
      (input.translations.get(locale) ?? []).map((t) => [t.key, t]),
    );
    const records = new Map(
      input.ownership.filter((r) => r.locale === locale).map((r) => [r.key, r]),
    );
    let missing = 0;
    let outdated = 0;
    const rows = fields.map((field) => {
      if (kept.has(field.key))
        return { key: field.key, state: "kept" as const };
      const state = classifyField(
        existing.get(field.key),
        records.get(field.key),
        input.hash,
      );
      if (state === "missing") missing += 1;
      if (state === "outdated") outdated += 1;
      return { key: field.key, state };
    });
    const owed = rows.filter((row) => row.state !== "kept").length;
    const done = owed - missing - outdated;
    return {
      locale,
      owed,
      missing,
      outdated,
      percent: owed === 0 ? 100 : Math.floor((done / owed) * 100),
      fields: rows,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* What needs a person                                                        */
/* -------------------------------------------------------------------------- */

export type WorkspaceTab =
  | "overview"
  | "details"
  | "attributes"
  | "variants"
  | "inventory"
  | "translations"
  | "activity";

export interface ProductIssue {
  key: string;
  text: string;
  /** Where it is fixed: a tab of this page, or another page. */
  target: { tab: WorkspaceTab } | { href: string };
  action: string;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Concrete problems, each with the place it is fixed. No score and no
 * "all good": an empty list is the answer when nothing is wrong.
 */
export function productIssues(input: {
  missingRequired: readonly string[];
  variantsWithoutSku: number;
  unmatchedVariants: number;
  locales: ReadonlyArray<{ name: string; missing: number; outdated: number }>;
  saleDecisions: ReadonlyArray<{
    campaignId: string;
    campaignName: string;
    count: number;
  }>;
  awaitingReview: boolean;
}): ProductIssue[] {
  const issues: ProductIssue[] = [];
  if (input.awaitingReview)
    issues.push({
      key: "review",
      text: "Waiting for review before it is published",
      target: { href: "/app/sources/review" },
      action: "Review",
    });
  if (input.missingRequired.length > 0)
    issues.push({
      key: "attributes",
      text: `${plural(input.missingRequired.length, "required detail is", "required details are")} missing`,
      target: { tab: "attributes" },
      action: "Fill in",
    });
  if (input.variantsWithoutSku > 0)
    issues.push({
      key: "no-sku",
      text: `${plural(input.variantsWithoutSku, "variant has", "variants have")} no SKU, so ${input.variantsWithoutSku === 1 ? "it" : "they"} cannot be matched to MetaKocka`,
      target: { tab: "variants" },
      action: "View variants",
    });
  if (input.unmatchedVariants > 0)
    issues.push({
      key: "unmatched",
      text: `${plural(input.unmatchedVariants, "variant has", "variants have")} no MetaKocka product`,
      target: { tab: "variants" },
      action: "View variants",
    });
  for (const decision of input.saleDecisions)
    issues.push({
      key: `sale-${decision.campaignId}`,
      text: `${decision.campaignName}: ${plural(decision.count, "price needs", "prices need")} a decision`,
      target: { href: `/app/sales/${decision.campaignId}/variants` },
      action: "Decide",
    });
  for (const locale of input.locales) {
    if (locale.missing === 0 && locale.outdated === 0) continue;
    const parts = [
      locale.missing > 0
        ? `${plural(locale.missing, "field", "fields")} missing`
        : null,
      locale.outdated > 0 ? `${locale.outdated} outdated` : null,
    ].filter(Boolean);
    issues.push({
      key: `translation-${locale.name}`,
      text: `${locale.name}: ${parts.join(", ")}`,
      target: { tab: "translations" },
      action: "Translate",
    });
  }
  return issues;
}
