/**
 * The one place export portal failures are classified (docs/sources.md
 * § Failures). Nothing else decides what a portal answer means.
 *
 * The portal is an HTTP API with ordinary status codes, so — unlike
 * MetaKocka — the kind is read from the status. What a screen does with it
 * is the same for every kind: say it in a sentence and leave the page
 * usable, because the page is a view onto the portal and the portal being
 * away is a state, not a crash.
 */
export type PortalFailureKind =
  /** No key, or the portal did not accept it (401). */
  | "unauthorized"
  /** The key is real but not for this shop (403). */
  | "forbidden"
  /** The thing asked for is gone (404). */
  | "not_found"
  /** The write was refused with reasons (422 or 400). */
  | "validation"
  /** The portal cannot do it right now and says why (409): a run in progress, a source switched off, a store awaiting reconnect. */
  | "conflict"
  /** The portal answered with something the contract does not describe. */
  | "unreadable"
  /** Too many requests (429). */
  | "throttled"
  /** The portal is down or broken (5xx). */
  | "server"
  /** It did not answer in time, or could not be reached at all. */
  | "unavailable"
  /** Nothing to call: EXPORT_PORTAL_URL is not set. */
  | "not_configured";

export interface PortalFieldError {
  field: string;
  message: string;
}

export class ExportPortalError extends Error {
  readonly kind: PortalFailureKind;
  readonly httpStatus: number | undefined;
  readonly path: string;
  /** Per-field messages on a validation refusal, keyed by field `key`. */
  readonly fieldErrors: readonly PortalFieldError[];

  constructor(options: {
    kind: PortalFailureKind;
    path: string;
    message: string;
    httpStatus?: number;
    fieldErrors?: readonly PortalFieldError[];
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "ExportPortalError";
    this.kind = options.kind;
    this.path = options.path;
    this.httpStatus = options.httpStatus;
    this.fieldErrors = options.fieldErrors ?? [];
  }
}

export function kindForStatus(status: number): PortalFailureKind {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 400 || status === 422) return "validation";
  if (status === 409) return "conflict";
  if (status === 429) return "throttled";
  if (status >= 500) return "server";
  return "unreadable";
}

/**
 * One sentence for a merchant. The portal's own message is used for a
 * validation refusal because it names the field, and for a 409 because it
 * names the state (a run already going, a store to reconnect); everything
 * else is said in this app's words so a stack trace or a hostname never
 * reaches a screen.
 */
export function describeForMerchant(error: ExportPortalError): string {
  switch (error.kind) {
    case "not_configured":
      return "The export portal is not configured on this server.";
    case "unauthorized":
      return "The export portal did not accept the API key. Generate a new key in the portal and paste it under Connection.";
    case "forbidden":
      return "The API key belongs to a different store in the export portal. Generate a key for this store.";
    case "not_found":
      return "The export portal no longer has this. It may have been removed in the portal.";
    case "validation":
      return error.message || "The export portal did not accept the change.";
    case "conflict":
      return (
        error.message ||
        "The export portal cannot do that right now. Try again in a moment."
      );
    case "throttled":
      return "The export portal is busy. Try again in a moment.";
    case "server":
      return "The export portal reported an error. Try again in a moment; if it keeps happening, check the portal.";
    case "unavailable":
      return "The export portal did not answer. Check that it is running and reachable from this server.";
    case "unreadable":
      return "The export portal answered in a form this app does not understand. The two may be on different versions.";
  }
}
