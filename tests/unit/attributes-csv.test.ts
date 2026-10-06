import { describe, expect, it } from "vitest";

import {
  CSV_COLUMNS,
  parseCsvRows,
  schemaFromCsv,
  schemaToCsv,
} from "~/domain/attributes/csv";
import { activeAttributes, pathOf } from "~/domain/attributes/resolve";
import { starterSchema } from "~/domain/attributes/starter";
import { emptySchema, type IdSource } from "~/domain/attributes/types";
import { attributeAiPrompt } from "~/web/lib/attribute-ai-prompt";

/**
 * docs/attributes.md § Import and export: the plan as one spreadsheet, named
 * rather than by id, so a person or an AI assistant can write it.
 */

function counter(): IdSource {
  let n = 0;
  return (prefix) => `${prefix}_${++n}`;
}

const HEADER = CSV_COLUMNS.join(",");

function csv(
  ...rows: Array<Partial<Record<(typeof CSV_COLUMNS)[number], string>>>
) {
  return [
    HEADER,
    ...rows.map((row) => CSV_COLUMNS.map((c) => row[c] ?? "").join(",")),
  ].join("\n");
}

/** What each assignable type ends up carrying, by path and attribute name. */
function carried(schema: ReturnType<typeof starterSchema>) {
  return Object.fromEntries(
    schema.types
      .filter((t) => t.leaf)
      .map((t) => [
        pathOf(schema, t.id).join(" > "),
        activeAttributes(schema, t.id).map(
          (a) => `${a.attribute.name}${a.required ? "*" : ""}`,
        ),
      ]),
  );
}

describe("the plan as CSV", () => {
  it("round-trips the starter plan to the same meaning", () => {
    const original = starterSchema();
    const imported = schemaFromCsv(schemaToCsv(original), counter());
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.schema.types).toHaveLength(original.types.length);
    expect(imported.schema.attributes).toHaveLength(original.attributes.length);
    expect(carried(imported.schema)).toEqual(carried(original));
    expect(schemaToCsv(imported.schema)).toBe(schemaToCsv(original));
  });

  it("exports an empty plan as the header alone", () => {
    expect(schemaToCsv(emptySchema()).trim()).toBe(HEADER);
  });

  it("creates ancestors from a path and infers what is assignable", () => {
    const imported = schemaFromCsv(
      csv(
        { record: "type", type: "All > Boards > Wave boards" },
        {
          record: "attribute",
          attribute: "Volume",
          format: "measurement",
          unit: "l",
        },
        { record: "attach", type: "All", attribute: "Volume" },
      ),
      counter(),
    );
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const names = imported.schema.types.map((t) => [t.name, t.leaf]);
    expect(names).toEqual([
      ["All", false],
      ["Boards", false],
      ["Wave boards", true],
    ]);
  });

  it("reads semicolons, quotes and a byte order mark", () => {
    expect(parseCsvRows('\uFEFFa;b\r\n"x;y";"say ""hi"""\r\n')).toEqual([
      ["a", "b"],
      ["x;y", 'say "hi"'],
    ]);
  });

  it("accepts merchant names for formats and derives option codes", () => {
    const imported = schemaFromCsv(
      csv(
        { record: "attribute", attribute: "Colour", format: "Single choice" },
        {
          record: "option",
          attribute: "Colour",
          label_en: "Dark blue",
          label_si: "Temno modra",
        },
      ),
      counter(),
    );
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.schema.valueLists[0]?.items).toEqual([
      { code: "dark_blue", en: "Dark blue", si: "Temno modra" },
    ]);
  });

  it("lists every wrong row with its number and changes nothing", () => {
    const imported = schemaFromCsv(
      csv(
        { record: "widget" },
        { record: "attribute", attribute: "Size", format: "huge" },
        { record: "attribute", attribute: "size" },
        { record: "option", attribute: "Size", label_en: "L" },
        { record: "attach", type: "Nowhere", set: "Missing" },
        { record: "attribute", attribute: "Flag", required: "maybe" },
      ),
      counter(),
    );
    expect(imported.ok).toBe(false);
    if (imported.ok) return;
    expect(imported.problems).toEqual([
      expect.stringMatching(/^Row 2: "widget" is not a record kind/),
      expect.stringMatching(/^Row 3: "huge" is not a format/),
      expect.stringMatching(/^Row 4: the attribute "size" is listed twice/),
      'Row 7: required must be yes or no, not "maybe".',
      expect.stringMatching(/^Row 5: "Size" is text; only/),
      expect.stringMatching(/^Row 6: the type "Nowhere" has no type row/),
      'Row 6: the set "Missing" has no set row.',
    ]);
  });

  it("refuses a file without the header", () => {
    const imported = schemaFromCsv("type,Boards\n", counter());
    expect(imported.ok).toBe(false);
  });
});

describe("the AI prompt", () => {
  it("states the header and carries an example this app imports", () => {
    const prompt = attributeAiPrompt();
    expect(prompt).toContain(HEADER);
    const example = /```csv\n([\s\S]*?)\n```/.exec(prompt)?.[1] ?? "";
    expect(schemaFromCsv(example, counter()).ok).toBe(true);
  });
});
