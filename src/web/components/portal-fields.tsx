import type { ReactNode } from "react";

import type { Field, FieldValues } from "~/domain/export-portal/contract";
import { groupFields, inputValue, isOn } from "~/domain/export-portal/fields";
import { Dropdown } from "~/web/components/dropdown";
import { leadingSwitch, shortLabel } from "~/web/lib/sources";

/**
 * A source's settings, drawn from the portal's description of them
 * (docs/sources.md § Fields).
 *
 * The portal says which fields a source kind has; this renders them with
 * the design system's own controls and nothing else. One control per field
 * type, the help line under it, the error against it. Fields the portal
 * grouped share a heading. Nothing here knows what any field means.
 *
 * State is the host's, as strings: a boolean is "true" or "", the way the
 * values are posted. `initialFieldState` builds it from stored values.
 *
 * Switches that follow one another share a two-column grid rather than
 * each taking a row of its own: a group that is six yes-or-no answers
 * reads as one list, not six cards, and the help of each stays under its
 * own box.
 */
export type FieldState = Record<string, string>;

export function initialFieldState(
  fields: readonly Field[],
  values: FieldValues,
): FieldState {
  const state: FieldState = {};
  for (const field of fields) {
    state[field.key] =
      field.type === "boolean"
        ? isOn(field, values)
          ? "true"
          : ""
        : inputValue(field, values);
  }
  return state;
}

/**
 * Consecutive fields of one shape become one run, so they can be laid
 * out together: switches as one list, inputs as one grid. A text area is
 * a run of its own, because it wants the whole width. Mixing shapes in
 * one grid — a dropdown beside a checkbox — lines nothing up with
 * anything, so a run never crosses a shape.
 */
type Shape = "switch" | "input" | "wide";

function shapeOf(field: Field): Shape {
  if (field.type === "boolean") return "switch";
  if (field.type === "textarea") return "wide";
  return "input";
}

function runsOf(
  fields: readonly Field[],
): Array<{ shape: Shape; fields: Field[] }> {
  const runs: Array<{ shape: Shape; fields: Field[] }> = [];
  for (const field of fields) {
    const shape = shapeOf(field);
    const last = runs[runs.length - 1];
    if (last && last.shape === shape && shape !== "wide")
      last.fields.push(field);
    else runs.push({ shape, fields: [field] });
  }
  return runs;
}

export function PortalFields({
  fields,
  values,
  state,
  errors,
  onChange,
  disabled = false,
  headings = true,
}: {
  fields: readonly Field[];
  /** What the portal holds, for the secret masks. */
  values: FieldValues;
  state: FieldState;
  errors: Record<string, string>;
  onChange: (key: string, value: string) => void;
  disabled?: boolean;
  /** Off inside a dialog that is already titled with the group's name. */
  headings?: boolean;
}) {
  const groups = groupFields(fields);

  const control = (field: Field, withoutHelp = false) => (
    <PortalField
      key={field.key}
      field={withoutHelp ? { ...field, help: null } : field}
      stored={values[field.key] ?? null}
      value={state[field.key] ?? ""}
      error={errors[field.key]}
      onChange={(value) => onChange(field.key, value)}
      disabled={disabled}
    />
  );

  return (
    <s-stack direction="block" gap="large">
      {groups.map((group, index) => {
        // A group led by a switch folds its settings away while the
        // switch is off; what is stored stays stored.
        const leader = leadingSwitch(group.fields);
        const folded = leader !== null && (state[leader.key] ?? "") !== "true";
        const shown = folded && leader ? [leader] : group.fields;
        return (
          <s-stack
            key={group.group ?? `group-${index}`}
            direction="block"
            gap="base"
          >
            {headings && group.group ? (
              <s-heading>{group.group}</s-heading>
            ) : null}
            {runsOf(shown).map((run, runIndex) => {
              if (run.fields.length === 1) return control(run.fields[0]!);
              if (run.shape === "switch") {
                // Four switches that each carry the same sentence say it
                // once, above the list, rather than four times.
                const helps = new Set(run.fields.map((f) => f.help ?? ""));
                const shared =
                  helps.size === 1 ? (run.fields[0]!.help ?? "") : "";
                return (
                  <s-stack
                    key={`switches-${runIndex}`}
                    direction="block"
                    gap="small-300"
                  >
                    {shared ? <s-text color="subdued">{shared}</s-text> : null}
                    {run.fields.map((field) => control(field, shared !== ""))}
                  </s-stack>
                );
              }
              return run.fields.map((field) => control(field));
            })}
          </s-stack>
        );
      })}
    </s-stack>
  );
}

/**
 * One field as its control. `bare` is the control alone, for a row that
 * already states the field's name and help beside it (a settings card):
 * the label stays for screen readers, and a choice reads by its name
 * alone, the way the card states it when not editing.
 */
export function PortalField({
  field: given,
  stored,
  value,
  error,
  onChange,
  disabled,
  bare = false,
}: {
  field: Field;
  stored: FieldValues[string] | null;
  value: string;
  error: string | undefined;
  onChange: (value: string) => void;
  disabled: boolean;
  bare?: boolean;
}) {
  const field: Field = bare
    ? {
        ...given,
        help: null,
        ...(given.options
          ? {
              options: given.options.map((o) => ({
                ...o,
                label: shortLabel(o.label),
              })),
            }
          : {}),
      }
    : given;
  const help = field.help ?? undefined;
  const hidden = bare
    ? ({ labelAccessibilityVisibility: "exclusive" } as const)
    : {};
  const capped = (width: `${number}px`, control: ReactNode) => (
    <s-box maxInlineSize={width}>{control}</s-box>
  );
  const common = {
    name: field.key,
    label: field.label,
    ...hidden,
    ...(help ? { details: help } : {}),
    ...(error ? { error } : {}),
    ...(field.placeholder ? { placeholder: field.placeholder } : {}),
    ...(field.required ? { required: true } : {}),
    ...(disabled ? { disabled: true } : {}),
  };

  switch (field.type) {
    case "boolean":
      return (
        <s-checkbox
          name={field.key}
          value="true"
          label={field.label}
          {...hidden}
          checked={value === "true"}
          onChange={(e) => onChange(e.currentTarget.checked ? "true" : "")}
          {...(help ? { details: help } : {})}
          {...(disabled ? { disabled: true } : {})}
          {...(error ? { error } : {})}
        />
      );
    case "select":
      return capped(
        "520px",
        <Dropdown
          name={field.key}
          label={field.label}
          {...(bare ? { hideLabel: true } : {})}
          {...(help ? { details: help } : {})}
          {...(error ? { error } : {})}
          value={value}
          options={field.options ?? []}
          onChange={onChange}
          {...(disabled ? { disabled: true } : {})}
        />,
      );
    case "textarea":
      return capped(
        "640px",
        <s-text-area
          {...common}
          value={value}
          onChange={(e) => onChange(e.currentTarget.value)}
        />,
      );
    case "number":
      return capped(
        "260px",
        <s-number-field
          {...common}
          value={value}
          onChange={(e) => onChange(e.currentTarget.value)}
        />,
      );
    case "secret":
      return capped(
        "520px",
        <s-password-field
          {...common}
          details={
            // The portal answers with a mask, never the value; the mask is
            // shown as it came so the person can tell which one is saved.
            stored !== null && stored !== ""
              ? [
                  typeof stored === "string"
                    ? `${stored} is saved. Leave blank to keep it.`
                    : "A value is saved. Leave blank to keep it.",
                  help,
                ]
                  .filter(Boolean)
                  .join(" ")
              : help
          }
          value={value}
          onChange={(e) => onChange(e.currentTarget.value)}
        />,
      );
    case "url":
      return capped(
        "520px",
        <s-url-field
          {...common}
          value={value}
          onChange={(e) => onChange(e.currentTarget.value)}
        />,
      );
    case "email":
      return capped(
        "520px",
        <s-email-field
          {...common}
          value={value}
          onChange={(e) => onChange(e.currentTarget.value)}
        />,
      );
    case "text":
      return capped(
        "520px",
        <s-text-field
          {...common}
          value={value}
          onChange={(e) => onChange(e.currentTarget.value)}
        />,
      );
  }
}
