import {
  getExportPortalSummary,
  type ExportPortalConnectionSummary,
} from "~/adapters/db/repositories/export-portal-connection.server";
import type { ExportPortalClient } from "~/adapters/export-portal/client.server";
import {
  isPortalConfigured,
  portalFailure,
  portalFor,
  type PortalAccess,
} from "~/adapters/export-portal/service.server";
import type { Principal } from "~/domain/types";

/**
 * What the Sources pages read (docs/sources.md § Screens), in one shape so
 * every page says the same thing when the portal cannot be read.
 *
 * These loaders do call the portal on a page load, which no MetaKocka page
 * does. The difference is deliberate: the Sources area *is* a view onto the
 * portal, nothing about a source is stored here, and the Translations pages
 * already read Shopify's locales live for the same reason. The call is one
 * request with a short timeout, and every failure is a state the page
 * renders rather than an error it throws.
 */

export type PortalState =
  | { kind: "not_configured"; message: string }
  | { kind: "not_connected"; message: string }
  | {
      kind: "unavailable";
      failure: ReturnType<typeof portalFailure>["kind"];
      message: string;
    };

export type PortalRead<T> = { kind: "read"; data: T } | PortalState;

/** Everything a Sources page needs besides its own data. */
export interface SourcesShell {
  configured: boolean;
  connection: ExportPortalConnectionSummary;
}

export async function loadSourcesShell(
  principal: Principal,
): Promise<SourcesShell> {
  return {
    configured: isPortalConfigured(),
    connection: await getExportPortalSummary(principal),
  };
}

function stateFor(access: Exclude<PortalAccess, { ok: true }>): PortalState {
  return { kind: access.reason, message: access.message };
}

/**
 * Run one read against the portal and hand back what it said, or the state
 * that explains why nothing came back.
 */
export async function readPortal<T>(
  principal: Principal,
  read: (client: ExportPortalClient) => Promise<T>,
): Promise<PortalRead<T>> {
  const access = await portalFor(principal);
  if (!access.ok) return stateFor(access);
  try {
    return { kind: "read", data: await read(access.client) };
  } catch (error) {
    const failure = portalFailure(error);
    return {
      kind: "unavailable",
      failure: failure.kind,
      message: failure.message,
    };
  }
}
