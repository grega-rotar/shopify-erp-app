import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import {
  AUTOFILL_REQUEST_LIMIT,
  applyAutofill,
  autofillAvailability,
  requestApplyAutofill,
  requestAutofill,
} from "~/adapters/products/autofill.server";
import type { Principal } from "~/domain/types";

/**
 * The list actions of AI autofill (docs/attributes.md § AI autofill),
 * shared by Sources › Review and Products: ask for suggestions on many
 * products, and apply everything suggested for many — while the page waits
 * up to `APPLY_BATCH`, in the background beyond it. Null for any other
 * intent, so a route can try this first and fall through to its own.
 */

export type ListActionResult = {
  ok: boolean;
  message: string;
  /** Work goes on in the background; the page should keep re-reading. */
  background?: boolean;
};

/** Suggestions applied in one press: each is a few Shopify calls. */
export const APPLY_BATCH = 25;

export async function autofillListAction(input: {
  admin: AdminApiContext;
  principal: Principal;
  actor: string | null;
  intent: string;
  ids: readonly string[];
}): Promise<ListActionResult | null> {
  const { admin, principal, actor, intent, ids } = input;

  if (intent === "autofill") {
    if (ids.length > AUTOFILL_REQUEST_LIMIT)
      return {
        ok: false,
        message: `Ask for at most ${AUTOFILL_REQUEST_LIMIT} products at a time.`,
      };
    const available = await autofillAvailability(principal);
    if (!available.ok) return { ok: false, message: available.message };
    const queued = await requestAutofill(principal, ids, actor);
    return {
      ok: true,
      message:
        queued === 0
          ? "Suggestions are already being made for those products."
          : `Asking the AI about ${queued} ${queued === 1 ? "product" : "products"}. Each shows its suggestion when it is ready.`,
    };
  }

  if (intent === "apply-autofill") {
    if (ids.length > APPLY_BATCH) {
      if (ids.length > AUTOFILL_REQUEST_LIMIT)
        return {
          ok: false,
          message: `Apply at most ${AUTOFILL_REQUEST_LIMIT} at a time, or use Apply all.`,
        };
      await requestApplyAutofill(principal, actor, ids);
      return {
        ok: true,
        background: true,
        message: `Applying ${ids.length} suggestions in the background. Each product leaves AI review as it is applied.`,
      };
    }
    const outcomes = [];
    for (const id of ids)
      outcomes.push(
        await applyAutofill(admin, principal, {
          productId: id,
          actor,
          keepType: true,
          keepValues: null,
        }),
      );
    const refused = outcomes.filter((outcome) => !outcome.ok);
    const applied = outcomes.length - refused.length;
    if (outcomes.length === 1 && outcomes[0]) return outcomes[0];
    return {
      ok: applied > 0,
      message:
        refused.length === 0
          ? `Applied the suggestions for ${applied} products.`
          : `Applied ${applied}; ${refused.length} could not be: ${refused[0]?.message ?? ""}`,
    };
  }

  return null;
}
