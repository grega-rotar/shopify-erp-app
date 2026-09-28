import type { Field, FieldValue, FieldValues } from "./contract";

/**
 * The form the portal described, read back from what a person submitted
 * (docs/sources.md § Fields).
 *
 * Pure. A form posts strings; this turns them into the values the contract
 * carries, per field type, and says which are missing or malformed. Secrets
 * are the one asymmetry: the portal never returns one, so an empty secret
 * input means "keep what is stored", never "clear it", and the key is left
 * out of the write altogether.
 */

export interface FieldProblem {
  key: string;
  message: string;
}

export interface ReadFieldsResult {
  values: FieldValues;
  problems: FieldProblem[];
}

function isBlank(value: string | null): value is null | "" {
  return value === null || value.trim() === "";
}

function required(field: Field): FieldProblem {
  return { key: field.key, message: `${field.label} is required.` };
}

/**
 * `raw(key)` is the posted string for a field, or null when nothing was
 * posted under that name. `rendered(key)` says whether the form carried the
 * field at all, which is how an unticked checkbox — which posts nothing —
 * is told apart from a field the form never showed.
 */
export function readFieldValues(
  fields: readonly Field[],
  raw: (key: string) => string | null,
  rendered: (key: string) => boolean = () => true,
): ReadFieldsResult {
  const values: FieldValues = {};
  const problems: FieldProblem[] = [];

  const optionalOrMissing = (field: Field): void => {
    if (field.required) problems.push(required(field));
    else values[field.key] = null;
  };

  for (const field of fields) {
    const posted = raw(field.key);

    switch (field.type) {
      case "boolean": {
        if (!rendered(field.key)) break;
        values[field.key] =
          posted !== null && posted !== "" && posted !== "false";
        break;
      }
      case "secret": {
        // Blank keeps the stored one; there is nothing to send.
        if (isBlank(posted)) break;
        values[field.key] = posted.trim();
        break;
      }
      case "number": {
        if (isBlank(posted)) {
          optionalOrMissing(field);
          break;
        }
        const number = Number(posted.trim());
        if (!Number.isFinite(number)) {
          problems.push({
            key: field.key,
            message: `${field.label} must be a number.`,
          });
          break;
        }
        values[field.key] = number;
        break;
      }
      case "select": {
        if (isBlank(posted)) {
          optionalOrMissing(field);
          break;
        }
        const allowed = (field.options ?? []).some((o) => o.value === posted);
        if (!allowed) {
          problems.push({
            key: field.key,
            message: `${field.label} must be one of the offered choices.`,
          });
          break;
        }
        values[field.key] = posted;
        break;
      }
      case "url": {
        if (isBlank(posted)) {
          optionalOrMissing(field);
          break;
        }
        const trimmed = posted.trim();
        if (!/^https?:\/\/\S+$/i.test(trimmed)) {
          problems.push({
            key: field.key,
            message: `${field.label} must be a web address starting with http:// or https://.`,
          });
          break;
        }
        values[field.key] = trimmed;
        break;
      }
      case "email": {
        if (isBlank(posted)) {
          optionalOrMissing(field);
          break;
        }
        const trimmed = posted.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
          problems.push({
            key: field.key,
            message: `${field.label} must be an email address.`,
          });
          break;
        }
        values[field.key] = trimmed;
        break;
      }
      case "text":
      case "textarea": {
        if (isBlank(posted)) {
          optionalOrMissing(field);
          break;
        }
        values[field.key] = field.type === "text" ? posted.trim() : posted;
        break;
      }
    }
  }

  return { values, problems };
}

function sameValue(a: FieldValue, b: FieldValue): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a === "number" || typeof b === "number")
    return Number(a) === Number(b);
  return a === b;
}

/**
 * Only what changed. The portal accepts a partial write, and re-sending a
 * value it already holds is noise in its audit trail. A secret is sent
 * whenever it was typed, because nothing about the stored one is known here.
 */
export function changedValues(
  fields: readonly Field[],
  stored: FieldValues,
  submitted: FieldValues,
): FieldValues {
  const changed: FieldValues = {};
  for (const field of fields) {
    if (!(field.key in submitted)) continue;
    const next = submitted[field.key] ?? null;
    if (field.type === "secret") {
      changed[field.key] = next;
      continue;
    }
    const current = stored[field.key] ?? null;
    if (!sameValue(current, next)) changed[field.key] = next;
  }
  return changed;
}

/** The string an input starts with: what is stored, or nothing for a secret. */
export function inputValue(field: Field, values: FieldValues): string {
  const value = values[field.key];
  if (value === null || value === undefined) return "";
  if (field.type === "secret") return "";
  if (typeof value === "boolean") return value ? "true" : "";
  return String(value);
}

/** Whether a boolean field is on, as stored. */
export function isOn(field: Field, values: FieldValues): boolean {
  const value = values[field.key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value === "true";
  if (typeof value === "number") return value !== 0;
  return false;
}

/** The fields under the headings the portal grouped them by, in order. */
export function groupFields(
  fields: readonly Field[],
): Array<{ group: string | null; fields: Field[] }> {
  const groups: Array<{ group: string | null; fields: Field[] }> = [];
  for (const field of fields) {
    const group = field.group ?? null;
    const last = groups[groups.length - 1];
    if (last && last.group === group) last.fields.push(field);
    else groups.push({ group, fields: [field] });
  }
  return groups;
}
