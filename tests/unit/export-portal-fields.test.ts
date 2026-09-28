import { describe, expect, it } from "vitest";

import type { Field, SourceSummary } from "~/domain/export-portal/contract";
import {
  changedValues,
  groupFields,
  inputValue,
  readFieldValues,
} from "~/domain/export-portal/fields";
import {
  attentionItems,
  describeSchedule,
  displayFieldValue,
  filterSources,
  sourceStatus,
  summarizeSources,
} from "~/web/lib/sources";

/**
 * The schema-driven form (docs/sources.md § Fields): what a posted form
 * becomes, per field type, and what of it is worth sending.
 */
const FIELDS: Field[] = [
  {
    key: "host",
    label: "Host",
    type: "text",
    required: true,
    group: "Delivery",
  },
  { key: "port", label: "Port", type: "number", group: "Delivery" },
  { key: "password", label: "Password", type: "secret", group: "Delivery" },
  { key: "compress", label: "Compress", type: "boolean" },
  {
    key: "format",
    label: "Format",
    type: "select",
    required: true,
    options: [
      { value: "csv", label: "CSV" },
      { value: "xml", label: "XML" },
    ],
  },
  { key: "callback", label: "Callback", type: "url" },
  { key: "contact", label: "Contact", type: "email" },
  { key: "notes", label: "Notes", type: "textarea" },
];

function posted(values: Record<string, string>) {
  return (key: string) => (key in values ? values[key]! : null);
}

describe("reading a posted portal form", () => {
  it("coerces each type and leaves a blank secret out", () => {
    const { values, problems } = readFieldValues(
      FIELDS,
      posted({
        host: "  sftp.partner.test ",
        port: "2222",
        password: "",
        compress: "true",
        format: "csv",
        callback: "https://partner.test/hook",
        contact: "ops@partner.test",
        notes: "  keep the spaces  ",
      }),
    );
    expect(problems).toEqual([]);
    expect(values).toEqual({
      host: "sftp.partner.test",
      port: 2222,
      compress: true,
      format: "csv",
      callback: "https://partner.test/hook",
      contact: "ops@partner.test",
      notes: "  keep the spaces  ",
    });
    expect("password" in values).toBe(false);
  });

  it("sends a typed secret and reads an unticked box as off", () => {
    const { values } = readFieldValues(
      FIELDS,
      posted({ host: "h", format: "xml", password: "hunter2", compress: "" }),
    );
    expect(values.password).toBe("hunter2");
    expect(values.compress).toBe(false);
  });

  it("names what is missing or malformed, once per field", () => {
    const { problems } = readFieldValues(
      FIELDS,
      posted({
        host: "",
        port: "many",
        format: "pdf",
        callback: "partner.test",
        contact: "not-an-email",
      }),
    );
    expect(problems.map((p) => p.key)).toEqual([
      "host",
      "port",
      "format",
      "callback",
      "contact",
    ]);
    expect(problems[0]!.message).toBe("Host is required.");
  });

  it("clears an optional field that was emptied", () => {
    const { values } = readFieldValues(
      FIELDS,
      posted({ host: "h", format: "csv", port: "", notes: "" }),
    );
    expect(values.port).toBeNull();
    expect(values.notes).toBeNull();
  });

  it("does not report a boolean the form did not render", () => {
    const { values } = readFieldValues(
      FIELDS,
      posted({ host: "h", format: "csv" }),
      (key) => key !== "compress",
    );
    expect("compress" in values).toBe(false);
  });
});

describe("what a save sends", () => {
  it("sends only what changed, and a secret whenever it was typed", () => {
    const stored = {
      host: "old.test",
      port: 22,
      password: "••••1234",
      compress: false,
      format: "csv",
    };
    const submitted = {
      host: "old.test",
      port: 22,
      password: "new-secret",
      compress: true,
      format: "csv",
      callback: null,
    };
    expect(changedValues(FIELDS, stored, submitted)).toEqual({
      password: "new-secret",
      compress: true,
    });
  });

  it("treats a number stored as a string as the same number", () => {
    expect(changedValues(FIELDS, { port: "22" }, { port: 22 })).toEqual({});
  });

  it("starts a secret input empty and a stored number as its text", () => {
    const values = { port: 2222, password: "••••1234" };
    expect(inputValue(FIELDS[1]!, values)).toBe("2222");
    expect(inputValue(FIELDS[2]!, values)).toBe("");
  });

  it("groups fields under the portal's headings in order", () => {
    expect(groupFields(FIELDS).map((g) => [g.group, g.fields.length])).toEqual([
      ["Delivery", 3],
      [null, 5],
    ]);
  });
});

describe("the Sources headline", () => {
  const base: SourceSummary = {
    id: "a",
    name: "A",
    kind: "k",
    kindLabel: "K",
    enabled: true,
    schedule: { mode: "automatic", nextRunAt: "2026-09-23T04:00:00Z" },
    health: "ok",
    lastRun: {
      id: "r1",
      sourceId: "a",
      status: "completed",
      finishedAt: "2026-09-22T04:01:00Z",
    },
  };

  it("is calm when everything works, and says how many are on", () => {
    const headline = summarizeSources([
      base,
      {
        ...base,
        id: "b",
        enabled: false,
        health: "off",
        schedule: { mode: "manual" },
      },
    ]);
    expect(headline.tone).toBe("healthy");
    expect(headline.summary).toBe("1 of 2 sources are on.");
    expect(headline.nextRunAt).toBe("2026-09-23T04:00:00Z");
    expect(headline.lastRunAt).toBe("2026-09-22T04:01:00Z");
  });

  it("is loud about the one that needs a person", () => {
    const headline = summarizeSources([
      base,
      { ...base, id: "b", health: "needs_attention" },
    ]);
    expect(headline.tone).toBe("needs_attention");
    expect(headline.summary).toBe("1 of 2 sources need attention.");
  });

  it("does not count a next run for a source that is off", () => {
    const headline = summarizeSources([{ ...base, enabled: false }]);
    expect(headline.nextRunAt).toBeNull();
  });

  it("counts what is running now", () => {
    const headline = summarizeSources([
      { ...base, lastRun: { id: "r", sourceId: "a", status: "running" } },
    ]);
    expect(headline.active).toBe(1);
  });
});

describe("how the Sources pages read the portal's words", () => {
  const base: SourceSummary = {
    id: "a",
    name: "Recharge all products",
    kind: "catalogue",
    kindLabel: "Catalogue export",
    destination: "Partner Supply",
    enabled: true,
    schedule: { mode: "automatic", nextRunAt: "2026-09-23T04:00:00Z" },
    health: "ok",
    lastRun: null,
  };

  it("keeps the schedule's words and sets a trailing cron expression aside", () => {
    expect(
      describeSchedule({
        mode: "automatic",
        description: "After each catalogue refresh (26 * * * *)",
      }),
    ).toEqual({
      mode: "automatic",
      summary: "After each catalogue refresh",
      technical: "26 * * * *",
    });
    // A parenthesis that is not an expression is part of the sentence.
    expect(
      describeSchedule({
        mode: "automatic",
        description: "Every day (Europe/Ljubljana)",
      }).summary,
    ).toBe("Every day (Europe/Ljubljana)");
    expect(describeSchedule({ mode: "manual" }).summary).toBe("Manual");
    expect(describeSchedule({ mode: "automatic" }).summary).toBe("Automatic");
  });

  it("gives a source one status: running, then off, then health", () => {
    expect(sourceStatus(base)).toEqual({ label: "Working", tone: undefined });
    // A warning, not a failure: the source runs, and what it reports is
    // a list of things to look at. Red is for a run that failed.
    expect(sourceStatus({ ...base, health: "needs_attention" })).toEqual({
      label: "Needs attention",
      tone: "warning",
    });
    expect(
      sourceStatus({ ...base, enabled: false, health: "needs_attention" })
        .label,
    ).toBe("Off");
    expect(
      sourceStatus({
        ...base,
        enabled: false,
        lastRun: { id: "r", sourceId: "a", status: "running" },
      }).label,
    ).toBe("Running");
  });

  it("reads a tally out of the last run's message, and nothing else", () => {
    expect(
      attentionItems("4581 stock · 324 content · 3 images · 1 unmatched"),
    ).toEqual([
      { count: 4581, label: "stock" },
      { count: 324, label: "content" },
      { count: 3, label: "images" },
      { count: 1, label: "unmatched" },
    ]);
    expect(attentionItems("1,204 prices, 3 images")).toEqual([
      { count: 1204, label: "prices" },
      { count: 3, label: "images" },
    ]);
    expect(attentionItems("SFTP refused the connection")).toBeNull();
    expect(attentionItems("3 images")).toBeNull();
    expect(attentionItems(null)).toBeNull();
  });

  it("states a stored value the way a read-only card shows it", () => {
    const values = {
      compress: true,
      format: "xml",
      password: "••••1234",
      port: null,
    };
    expect(displayFieldValue(FIELDS[3]!, values)).toEqual({
      text: "On",
      set: true,
    });
    expect(displayFieldValue(FIELDS[4]!, values)).toEqual({
      text: "XML",
      set: true,
    });
    expect(displayFieldValue(FIELDS[2]!, values)).toEqual({
      text: "••••1234",
      set: true,
    });
    expect(displayFieldValue(FIELDS[1]!, values)).toEqual({
      text: "Not set",
      set: false,
    });
  });

  it("filters the list by words, status and kind", () => {
    const sources: SourceSummary[] = [
      base,
      {
        ...base,
        id: "b",
        name: "Brand feed",
        kind: "feed",
        kindLabel: "Feed",
        health: "needs_attention",
      },
      { ...base, id: "c", name: "Old", enabled: false, health: "off" },
      {
        ...base,
        id: "d",
        name: "Busy",
        lastRun: { id: "r", sourceId: "d", status: "running" },
      },
    ];
    const ids = (filters: Parameters<typeof filterSources>[1]) =>
      filterSources(sources, filters).map((s) => s.id);
    expect(ids({ query: "", status: "", kind: "" })).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(ids({ query: "supply", status: "", kind: "" })).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(ids({ query: "brand", status: "", kind: "" })).toEqual(["b"]);
    expect(ids({ query: "", status: "needs_attention", kind: "" })).toEqual([
      "b",
    ]);
    expect(ids({ query: "", status: "off", kind: "" })).toEqual(["c"]);
    expect(ids({ query: "", status: "running", kind: "" })).toEqual(["d"]);
    expect(ids({ query: "", status: "ok", kind: "" })).toEqual(["a"]);
    expect(ids({ query: "", status: "", kind: "feed" })).toEqual(["b"]);
  });
});
