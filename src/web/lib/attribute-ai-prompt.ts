import { CSV_COLUMNS, CSV_RECORDS, schemaToCsv } from "~/domain/attributes/csv";
import { starterSchema } from "~/domain/attributes/starter";
import { DATA_TYPES } from "~/domain/attributes/types";
import { DATA_TYPE_HELP } from "~/web/lib/attributes";

/**
 * The prompt a person pastes into an AI assistant, with their exported CSV,
 * to plan product types, attributes and sets outside the app
 * (docs/attributes.md § Planning with an AI assistant). The app itself calls
 * no AI here: it hands over the format, takes the file back and checks it
 * like any other import. The example is the starter plan run through the
 * real exporter, so it is always a file this app accepts.
 */
export function attributeAiPrompt(): string {
  const formats = DATA_TYPES.map(
    (code) => `  - ${code}: ${DATA_TYPE_HELP[code]}`,
  ).join("\n");

  return `You are helping me plan the product data model of my Shopify store: product types, the attributes (metafields) each type needs, and reusable attribute sets. The plan is imported into my Shopify app as one CSV file, so your answer must be that CSV file.

## What I will give you
- My current plan exported as CSV (if I have one). Treat it as the starting point: keep what is there unless I ask to change it, and return the WHOLE plan, not only the changes — the import replaces everything.
- A description of my products, a product list, supplier sheets, or competitor pages.

## What you return
One CSV file in a single code block, nothing else in the block. Comma-separated, first row exactly the header below, every row the same columns. Quote a cell that contains a comma, a quote or a line break ("" for a quote inside). After the block, list in a few lines what you added, changed and assumed.

Header:
${CSV_COLUMNS.join(",")}

## The record column says what a row is (${CSV_RECORDS.join(", ")})
- type: a product type. "type" is its full path from the top, names joined with " > ", e.g. "All products > Windsurf > Sails > Wave sails". Parents are created from the path. "assignable" is yes when products can be given this type, no for a grouping category (empty: yes when it has no children). "shopify_category" is optional, the Shopify standard product category path.
- set: a reusable bundle of attributes. "set" is its name, "description" optional.
- attribute: one field. "attribute" is its name (unique in the file). "set" is the set it belongs to (optional, at most one). "format" is one of the codes below. "unit" for numbers and measurements (cm, kg, m², l …). "level" is product or variant (variant when it differs per size/colour). "shopify_field" is the metafield as namespace.key, lowercase with underscores, namespace "recharge" for my own fields, e.g. recharge.sail_size (3–255 characters before the dot, 3–64 after). "required", "filterable", "searchable", "comparable" are yes/no. "native" is yes only when the value lives in a built-in Shopify field (vendor, product type…) rather than a metafield. "description" says what the field means.
- option: one choice of a single_select or multi_select attribute, in display order. "attribute" names it, "code" is a short lowercase id (unique within the attribute), "label_en" the English label, "label_si" the Slovenian label.
- attach: puts a set or an attribute on a type. "type" is the type path and EITHER "set" OR "attribute". Everything attached to a type is inherited by every type beneath it, so attach shared things as high as they apply. Prefer attaching sets over single attributes.
- requirement: on exactly one type, makes an attribute required (required = yes) or optional (required = no) against its default. "description" gives the reason. Not inherited.
- remove: hides an inherited attribute on exactly one type. Not inherited.

Leave a column empty when it does not apply to the row.

## Formats
${formats}

## Rules of good planning
- Build a tree that groups products the way a shopper narrows them down; only the types products are put in are assignable.
- Define each attribute once and reuse it; never make "Length (boards)" and "Length (sails)" when one "Length" attached in two places will do.
- Use single_select / multi_select whenever the values are a known list, and give every option a Slovenian label.
- Use measurement with a unit for physical sizes, not text.
- Mark required only what every product of that type must have before it is sold.
- Every attribute should be attached somewhere, every assignable type should end up with attributes, and every attribute should have a shopify_field.

## Example of a valid file
\`\`\`csv
${schemaToCsv(starterSchema()).trim()}
\`\`\`

My current plan and my products follow.
`;
}
