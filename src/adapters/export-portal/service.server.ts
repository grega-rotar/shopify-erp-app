import { getEnv } from "~/adapters/config/env.server";
import {
  getExportPortalApiKey,
  markExportPortalVerified,
} from "~/adapters/db/repositories/export-portal-connection.server";
import { shopDomainOf, type Principal } from "~/domain/types";

import { ExportPortalClient } from "./client.server";
import { ExportPortalError, describeForMerchant } from "./errors";

/**
 * A client for the shop, or the reason there is none (docs/sources.md
 * § The adapter). Both web and jobs come through here, so "configured" and
 * "connected" are answered in one place.
 */

export type PortalAccess =
  | { ok: true; client: ExportPortalClient }
  | {
      ok: false;
      reason: "not_configured" | "not_connected";
      message: string;
    };

export function isPortalConfigured(): boolean {
  return getEnv().EXPORT_PORTAL_URL !== undefined;
}

export async function portalFor(
  principal: Principal,
  options: { timeoutMs?: number } = {},
): Promise<PortalAccess> {
  const baseUrl = getEnv().EXPORT_PORTAL_URL;
  if (!baseUrl) {
    return {
      ok: false,
      reason: "not_configured",
      message:
        "The export portal is not configured on this server. Set EXPORT_PORTAL_URL in the server environment.",
    };
  }

  const apiKey = await getExportPortalApiKey(principal);
  if (!apiKey) {
    return {
      ok: false,
      reason: "not_connected",
      message: "Connect the export portal first.",
    };
  }

  return {
    ok: true,
    client: new ExportPortalClient(
      { baseUrl, apiKey, shopDomain: shopDomainOf(principal) },
      options,
    ),
  };
}

/**
 * The connection test: ask the portal who the key is and remember the
 * answer. Anything the portal refuses is thrown as `ExportPortalError`.
 */
export async function verifyConnection(
  client: ExportPortalClient,
  principal: Principal,
) {
  const connection = await client.connection();
  await markExportPortalVerified(principal, connection.tenant);
  return connection;
}

/** A portal failure as a screen states it; anything else is rethrown. */
export function portalFailure(error: unknown): {
  kind: ExportPortalError["kind"];
  message: string;
  fieldErrors: Record<string, string>;
} {
  if (!(error instanceof ExportPortalError)) throw error;
  const fieldErrors: Record<string, string> = {};
  for (const item of error.fieldErrors)
    fieldErrors[item.field] ??= item.message;
  return { kind: error.kind, message: describeForMerchant(error), fieldErrors };
}
