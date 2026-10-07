import { getTypeMenu } from "~/adapters/db/repositories/type-menu.server";
import { getLogger } from "~/adapters/observability/logger.server";
import { enqueue } from "~/adapters/queue/boss.server";
import { QUEUES, typeMenuAutoKey } from "~/adapters/queue/queues";
import { shopDomainOf, type Principal } from "~/domain/types";

/**
 * How long an automatic update waits, so a burst of edits (a tree being
 * rearranged, a catalogue of webhooks) becomes one run that reads the end
 * state.
 */
export const TYPE_MENU_AUTO_DELAY_SECONDS = 60;

/**
 * Keeps the store menu current without a press (docs/attributes.md § Store
 * menu): once the menu has been made, a change to the type tree or to a
 * product's type queues one update a minute later. Before the first press
 * nothing is queued; the menu is the merchant's to ask for. A failure to
 * queue is logged, never thrown, so it cannot break the edit that caused it.
 */
export async function requestTypeMenuUpdate(
  principal: Principal,
): Promise<void> {
  try {
    const menu = await getTypeMenu(principal);
    if (!menu?.menuId) return;
    await queueTypeMenuUpdate(shopDomainOf(principal));
  } catch (error) {
    getLogger().warn(
      { err: error, shop: shopDomainOf(principal) },
      "Automatic menu update not queued",
    );
  }
}

/** The job itself, delayed and folded into any update already waiting. */
export async function queueTypeMenuUpdate(shopDomain: string): Promise<void> {
  await enqueue(
    QUEUES.typeMenuSync,
    { shopDomain, requestedBy: null, automatic: true },
    {
      singletonKey: typeMenuAutoKey(shopDomain),
      startAfterSeconds: TYPE_MENU_AUTO_DELAY_SECONDS,
    },
  );
}
