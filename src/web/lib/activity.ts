import { describeLanguage } from "~/domain/translations/languages";

/**
 * One place that turns an `event_log` row into words.
 *
 * The log is the permanent audit trail (CLAUDE.md §6) and its rows are named
 * for machines: `inventory.sync_skipped`, `metakocka.credentials_saved`. A
 * merchant should never be shown those. Every screen that displays activity
 * goes through here, so the same event reads the same way everywhere.
 */
export interface DescribedEvent {
  /** What the entry is about, as a heading: a warehouse name, "Catalogue". */
  title: string;
  /** One plain sentence, with the numbers that matter. */
  text: string;
  /** False when a person has to do something about it. */
  ok: boolean;
}

function count(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** "4,734", as the rest of Home writes a count. */
function fmt(n: number): string {
  return n.toLocaleString("en");
}

export function products(n: number): string {
  return n === 1 ? "1 product" : `${n.toLocaleString("en")} products`;
}

/** Why a warehouse was skipped, and what to do about it. */
const SKIP_REASONS: Record<string, string> = {
  missing_api_user_email:
    "Add the MetaKocka API user email on the Connection page, then sync again.",
  warehouse_not_found:
    "This warehouse is no longer in MetaKocka. Reload the list, then check the location.",
  nothing_to_sync: "There was nothing to send.",
};

/**
 * The same stock event as `describeEvent`, in a caption's worth of words.
 *
 * The locations list shows one of these under each row, where a sentence would
 * wrap to three lines on a phone and bury the row it belongs to. It is a label,
 * not prose: "27 products updated", never "Updated 27 products in Shopify to
 * match MetaKocka."
 */
export interface BriefEvent {
  text: string;
  ok: boolean;
}

export function describeSyncBriefly(event: {
  event: string;
  detail: unknown;
}): BriefEvent {
  const d = (event.detail ?? {}) as Record<string, unknown>;

  switch (event.event) {
    case "inventory.synced": {
      const changed = count(d.written) + count(d.stocked);
      return {
        text:
          changed === 0 ? "Already up to date" : `${products(changed)} updated`,
        ok: true,
      };
    }

    case "inventory.written_to_metakocka":
      return { text: `${products(count(d.fromShopify))} sent`, ok: true };

    case "inventory.sync_skipped":
      return { text: "Nothing synced", ok: false };

    default:
      return { text: "Synced", ok: true };
  }
}

export function describeEvent(
  event: { event: string; detail: unknown },
  /** Supply source id to warehouse name, when the page has it. */
  names?: Map<string, string>,
  entityId?: string | null,
): DescribedEvent {
  const d = (event.detail ?? {}) as Record<string, unknown>;
  const warehouse =
    (entityId && names?.get(entityId)) ||
    (typeof d.source === "string" ? d.source : null) ||
    "A warehouse";

  switch (event.event) {
    case "inventory.synced": {
      const changed = count(d.written) + count(d.stocked);
      const unchanged = count(d.unchanged);
      return {
        title: warehouse,
        text:
          changed === 0
            ? "Shopify already matched MetaKocka. Nothing needed changing."
            : `Updated ${products(changed)} in Shopify to match MetaKocka.` +
              (unchanged > 0
                ? ` ${products(unchanged)} were already correct.`
                : ""),
        ok: true,
      };
    }

    case "inventory.written_to_metakocka": {
      const sent = count(d.fromShopify);
      const preserved = count(d.preserved);
      return {
        title: warehouse,
        text:
          `Sent stock for ${products(sent)} from Shopify to MetaKocka.` +
          (preserved > 0
            ? ` ${products(preserved)} this app does not manage were left as MetaKocka had them.`
            : ""),
        ok: true,
      };
    }

    case "inventory.sync_skipped": {
      const reason = String(d.reason ?? "");
      return {
        title: warehouse,
        text: `Nothing was synced. ${SKIP_REASONS[reason] ?? `Reported reason: ${reason || "unknown"}.`}`,
        ok: false,
      };
    }

    case "catalogue.synced": {
      const matched = count(d.matched);
      const unmatched = count(d.unmatched);
      return {
        title: "Catalogue",
        text:
          unmatched > 0
            ? `Read ${fmt(count(d.variants))} Shopify variants. ${fmt(matched)} found their MetaKocka product, ${fmt(unmatched)} did not.`
            : `Read ${fmt(count(d.variants))} Shopify variants. All ${fmt(matched)} found their MetaKocka product.`,
        ok: unmatched === 0,
      };
    }

    case "products.synced": {
      const renamed = count(d.renamed);
      const created = count(d.created);
      const repriced = count(d.repriced);
      const retyped = count(d.retyped);
      const failed = count(d.failed);
      const parts: string[] = [];
      if (renamed > 0) parts.push(`renamed ${products(renamed)}`);
      if (created > 0) parts.push(`created ${products(created)} in MetaKocka`);
      if (repriced > 0) parts.push(`repriced ${products(repriced)}`);
      // Named for the MetaKocka boxes it ticks, because "retyped" reads as a
      // typing correction rather than as Prodajni and Nabavni changing.
      if (retyped > 0)
        parts.push(`changed the product type of ${products(retyped)}`);
      if (parts.length === 0) parts.push("nothing needed changing");

      const summary = `Sent product names to MetaKocka: ${parts.join(", ")}.`;

      /*
       * A count is not a reason.
       *
       * "39 products were rejected by MetaKocka and were left alone" was true
       * and useless: the merchant had deleted a pricelist in MetaKocka, and
       * nothing on the screen connected the two. MetaKocka's `opr_desc` is the
       * only account of the cause that exists (CLAUDE.md §3) and §2.8 wants a
       * message that says what is wrong, so it is quoted rather than counted.
       */
      const stopped =
        typeof d.pricingStopped === "string" && d.pricingStopped.trim() !== ""
          ? d.pricingStopped.trim()
          : null;

      if (stopped) {
        const named =
          typeof d.pricelistCode === "string" && d.pricelistCode.trim() !== ""
            ? `pricelist ${d.pricelistCode.trim()}`
            : "the pricelist";

        return {
          title: "Product sync",
          text:
            `${summary} MetaKocka refused ${named}, so prices were not sent and names went out on their own. ` +
            `MetaKocka said: “${stopped}”. Check the pricelist in the product sync settings.`,
          ok: false,
        };
      }

      if (failed === 0)
        return { title: "Product sync", text: summary, ok: true };

      const reasons = Array.isArray(d.reasons)
        ? (d.reasons as { reason?: unknown; count?: unknown }[])
        : [];
      const leading =
        typeof reasons[0]?.reason === "string" ? reasons[0].reason.trim() : "";

      return {
        title: "Product sync",
        text:
          `${summary} MetaKocka rejected ${products(failed)}, which were left alone.` +
          (leading ? ` It said: “${leading}”.` : ""),
        ok: false,
      };
    }

    case "products.sync_skipped": {
      const reason = String(d.reason ?? "");
      const explained: Record<string, string> = {
        disabled: "Product sync is turned off in the settings.",
        not_connected: "MetaKocka is not connected yet.",
        missing_pricelist_code:
          "Sending prices needs a pricelist code that exists in MetaKocka.",
      };
      return {
        title: "Product sync",
        text: `Nothing was sent. ${explained[reason] ?? `Reported reason: ${reason || "unknown"}.`}`,
        ok: false,
      };
    }

    case "product_sync.settings_saved":
      return {
        title: "Product sync",
        text: d.enabled
          ? "Saved the settings. Product names will be sent to MetaKocka."
          : "Saved the settings. Product names are not being sent.",
        ok: true,
      };

    case "warehouse_mapping.saved": {
      const location = typeof d.location === "string" ? d.location : null;
      const warehouse =
        typeof d.warehouse === "string" ? d.warehouse : String(d.mark ?? "");
      return {
        title: "Locations",
        text: location
          ? `Connected ${location} to ${warehouse}.`
          : `Disconnected ${warehouse} from its location.`,
        ok: true,
      };
    }

    case "supply_defaults.saved": {
      const followed = count(d.updated);
      return {
        title: "Sync defaults",
        text:
          followed === 0
            ? "Saved the defaults. Every location has its own setting."
            : `Saved the defaults. ${followed} ${followed === 1 ? "location follows" : "locations follow"} them.`,
        ok: true,
      };
    }

    case "profit_center.added":
      return {
        title: "Profit centres",
        text: `Added ${String(d.value ?? "")} to the register.`.trim(),
        ok: true,
      };

    case "profit_center.removed":
      return {
        title: "Profit centres",
        text: `Removed ${String(d.value ?? "")} from the register.`.trim(),
        ok: true,
      };

    case "profit_centers.rejected": {
      const values = Array.isArray(d.values) ? d.values.map(String) : [];
      return {
        title: "Profit centres",
        text: `MetaKocka no longer has ${values.join(", ")}. Check the locations using ${values.length === 1 ? "it" : "them"}.`,
        ok: false,
      };
    }

    case "warehouse_mapping.retired": {
      const names = Array.isArray(d.names) ? d.names.map(String) : [];
      return {
        title: "Warehouses",
        text: `${names.join(", ")} ${names.length === 1 ? "is" : "are"} no longer in MetaKocka. Stock sync was turned off for ${names.length === 1 ? "it" : "them"}.`,
        ok: false,
      };
    }

    case "payment_types.saved":
      return {
        title: "Payment types",
        text: `Saved ${count(d.count)} gateway mappings.`,
        ok: true,
      };

    case "metakocka.credentials_saved":
      return {
        title: "MetaKocka",
        text: "Saved the connection details.",
        ok: true,
      };

    case "metakocka.connection_verified":
      return {
        title: "MetaKocka",
        text: "Tested the connection and it worked.",
        ok: true,
      };

    case "metakocka.disconnected":
      return {
        title: "MetaKocka",
        text: "Disconnected, and everything this app held for the store was erased. Nothing in MetaKocka was changed.",
        ok: true,
      };

    case "tax.settings.saved":
      return {
        title: "Taxes & VAT",
        text: "The tax registrations and policy were saved.",
        ok: true,
      };

    case "tax.mappings.saved":
      return {
        title: "Taxes & VAT",
        text: "The MetaKocka tax mappings were saved.",
        ok: true,
      };

    case "tax.country_rates.saved":
      return {
        title: "Taxes & VAT",
        text: "The country VAT rates were saved.",
        ok: true,
      };

    case "tax.overrides.saved":
      return {
        title: "Taxes & VAT",
        text: "The tax overrides were saved.",
        ok: true,
      };

    case "app.installed":
      return { title: "This app", text: "Installed on this store.", ok: true };

    case "app.scopes_updated":
      return {
        title: "This app",
        text: "The permissions this app holds were updated.",
        ok: true,
      };

    case "app.uninstalled":
      return { title: "This app", text: "Uninstalled.", ok: true };

    case "compliance.customers_data_request":
      return {
        title: "Privacy",
        text: "Shopify asked for a copy of a customer's data.",
        ok: true,
      };

    case "compliance.customers_redact":
      return {
        title: "Privacy",
        text: "Deleted a customer's personal data at Shopify's request.",
        ok: true,
      };

    case "setup.completed":
      return {
        title: "Setup",
        text: "Setup was finished and synchronization started.",
        ok: true,
      };

    case "sales_order.settings_saved":
      return {
        title: "Orders",
        text:
          d.transferOrders === false
            ? "Saved the order settings. Orders are not sent to MetaKocka."
            : "Saved the order settings.",
        ok: true,
      };

    case "sales_order.backlog_queued": {
      const orders = count(d.orders);
      return {
        title: "Orders",
        text: `Queued ${orders === 1 ? "1 order" : `${orders} orders`} received while order transfer was off.`,
        ok: true,
      };
    }

    case "orders.reconciled": {
      const ingested = count(d.ingested);
      const updated = count(d.updated);
      const parts: string[] = [];
      if (ingested > 0)
        parts.push(
          `${ingested} missed ${ingested === 1 ? "order" : "orders"} picked up`,
        );
      if (updated > 0) parts.push(`${updated} updated`);
      return {
        title: "Orders",
        text: `Checked Shopify for changes to orders: ${parts.join(", ") || "nothing had changed"}.`,
        ok: true,
      };
    }

    case "translation_sync.completed":
      return {
        title: "Translations",
        text: "Translation sync completed.",
        ok: true,
      };

    case "translation_sync.nothing_to_do":
      return {
        title: "Translations",
        text: "Translation sync checked the store. Everything was already up to date.",
        ok: true,
      };

    case "translation_sync.failed": {
      const reason = typeof d.reason === "string" ? d.reason.trim() : "";
      return {
        title: "Translations",
        text: `A translation sync could not run.${reason ? ` It said: “${reason}”.` : ""}`,
        ok: false,
      };
    }

    case "translation_sync.started": {
      const locales = Array.isArray(d.targetLocales)
        ? d.targetLocales.length
        : 0;
      return {
        title: "Translations",
        text:
          locales > 0
            ? `A translation sync started for ${locales === 1 ? "1 language" : `${locales} languages`}.`
            : "A translation sync started.",
        ok: true,
      };
    }

    case "translation_sync.cancel_requested":
    case "translation_sync.cancelled":
      return {
        title: "Translations",
        text: "A translation sync was cancelled.",
        ok: true,
      };

    case "translation_language.added":
      return {
        title: "Translations",
        text: `Added ${languageOf(entityId)}.`,
        ok: true,
      };

    case "translation_language.removed":
      return {
        title: "Translations",
        text: `Removed ${languageOf(entityId)}.`,
        ok: true,
      };

    case "translation_language.settings_changed":
    case "translation_language.markets_changed":
      return {
        title: "Translations",
        text: `Changed the settings for ${languageOf(entityId)}.`,
        ok: true,
      };

    case "translation_language.remove_translations_requested":
      return {
        title: "Translations",
        text: `Deleting the translations for ${languageOf(entityId)}.`,
        ok: true,
      };

    case "translation_profile.built":
      return {
        title: "Translations",
        text: "Learnt about the store, for the AI to translate with.",
        ok: true,
      };

    case "translation_profile.settings_changed":
    case "translation_profile.rebuild_requested":
      return {
        title: "Translations",
        text: "Changed what the AI knows about the store.",
        ok: true,
      };

    case "export_source.created":
      return {
        title: "Sources",
        text: `Created ${nameOr(d.name, "a source")} in the export portal.`,
        ok: true,
      };

    case "export_source.enabled":
      return {
        title: "Sources",
        text: `Switched ${nameOr(d.name, "a source")} on.`,
        ok: true,
      };

    case "export_source.disabled":
      return {
        title: "Sources",
        text: `Switched ${nameOr(d.name, "a source")} off.`,
        ok: true,
      };

    case "export_source.settings_saved":
      return { title: "Sources", text: "Saved a source's settings.", ok: true };

    case "export_source.run_requested":
      return { title: "Sources", text: "Asked a source to run now.", ok: true };

    case "export_source.deleted":
      return { title: "Sources", text: "Deleted a source.", ok: true };

    case "export_portal.key_saved":
    case "export_portal.connection_verified":
      return {
        title: "Sources",
        text: "Connected to the export portal.",
        ok: true,
      };

    case "export_portal.disconnected":
      return {
        title: "Sources",
        text: "Disconnected from the export portal.",
        ok: true,
      };

    case "product.review_approved":
      return {
        title: "Sources",
        text: `Approved ${nameOr(d.title, "a product")} for the store.`,
        ok: true,
      };

    default:
      if (event.event.startsWith("sale_campaign.")) {
        return describeCampaign(
          event.event,
          d,
          (entityId && names?.get(entityId)) || null,
        );
      }
      /*
       * A new event nobody has written a sentence for yet. The raw name is
       * syntax (docs/ui-conventions.md § Element semantics), so the area it
       * belongs to stands in: less said, but nothing a merchant cannot read.
       */
      return {
        title: areaOfEvent(event.event),
        text: "An update was recorded.",
        ok: true,
      };
  }
}

function nameOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : fallback;
}

/** "German (de)", the glossary's form of a language. */
function languageOf(locale: string | null | undefined): string {
  if (!locale) return "a language";
  return `${describeLanguage(locale).name} (${locale})`;
}

/** What a campaign did, under the campaign's own name. */
function describeCampaign(
  event: string,
  d: Record<string, unknown>,
  name: string | null,
): DescribedEvent {
  const title = name ?? "Sale campaign";
  const counts = (d.counts ?? {}) as Record<string, unknown>;
  const variants = (n: number) =>
    n === 1 ? "1 variant" : `${fmt(n)} variants`;

  switch (event) {
    case "sale_campaign.apply_finished": {
      const applied = count(counts.applied);
      const failed = count(counts.failed);
      return {
        title,
        text:
          `Sale prices applied to ${variants(applied)}.` +
          (failed > 0 ? ` ${variants(failed)} could not be changed.` : ""),
        ok: failed === 0,
      };
    }
    case "sale_campaign.restore_finished": {
      const restored = count(counts.restored);
      const failed = count(counts.restore_failed);
      return {
        title,
        text:
          `Original prices put back on ${variants(restored)}.` +
          (failed > 0 ? ` ${variants(failed)} could not be put back.` : ""),
        ok: failed === 0,
      };
    }
    case "sale_campaign.membership_changed":
      return {
        title,
        text: `${variants(count(d.added))} joined, ${count(d.released)} left.`,
        ok: true,
      };
    case "sale_campaign.conflict_detected":
      return { title, text: "Overlaps another campaign.", ok: false };
    default:
      return {
        title,
        text: CAMPAIGN_COPY[event] ?? "The campaign was updated.",
        ok: true,
      };
  }
}

const CAMPAIGN_COPY: Record<string, string> = {
  "sale_campaign.created": "Campaign created.",
  "sale_campaign.edited": "Campaign edited.",
  "sale_campaign.scheduled": "Scheduled to start.",
  "sale_campaign.unscheduled": "Moved back to draft.",
  "sale_campaign.activated": "Campaign started.",
  "sale_campaign.paused": "Campaign paused.",
  "sale_campaign.resumed": "Campaign resumed.",
  "sale_campaign.ending": "Ending: original prices are being put back.",
  "sale_campaign.completed": "Campaign ended.",
  "sale_campaign.cancelled": "Campaign cancelled.",
  "sale_campaign.deleted": "Campaign deleted.",
  "sale_campaign.restore_requested": "Putting original prices back.",
  "sale_campaign.retry_requested": "Retrying the variants that failed.",
};

/** The area an event belongs to, from its name, for events with no sentence. */
function areaOfEvent(event: string): string {
  const prefix = event.split(".")[0] ?? "";
  if (prefix.startsWith("translation")) return "Translations";
  if (prefix.startsWith("sale_")) return "Sales";
  if (prefix.startsWith("export_") || prefix === "product") return "Sources";
  if (prefix === "order" || prefix === "orders" || prefix === "sales_order")
    return "Orders";
  if (
    prefix === "inventory" ||
    prefix.startsWith("warehouse") ||
    prefix.startsWith("supply")
  )
    return "Inventory";
  if (
    prefix.startsWith("product") ||
    prefix === "catalogue" ||
    prefix === "pricelists"
  )
    return "Products";
  if (prefix === "payment_types") return "Payments";
  if (prefix === "tax") return "Taxes & VAT";
  if (prefix === "metakocka" || prefix.startsWith("profit_center"))
    return "MetaKocka";
  if (prefix === "exception") return "Needs attention";
  return "This app";
}

/**
 * Events Home leaves out: one row per order, per variant or per resource, or
 * a step inside a run whose outcome has its own event. They are true and
 * each page that owns them shows them; on Home a busy hour of them pushes
 * every other kind of activity off the list.
 */
export const HOME_ACTIVITY_EXCLUDED: readonly string[] = [
  "order.",
  "sale_variant.",
  "exception.",
  "translation.",
  "translation_sync.started",
  "translation_sync.cancel_requested",
  "inventory.stock_event_received",
  "catalogue.snapshot",
  "pricelists.",
  "payment_types.loaded",
  "payment_types.discovered",
  "compliance.",
];

export interface ActivityEvent {
  id: string;
  at: Date;
  event: string;
  entityId: string | null;
  detail: unknown;
}

/**
 * Home's recent activity: the newest few events, one per kind.
 *
 * A translation sync runs every few minutes and a stock sweep every five,
 * so the newest ten rows are often ten of the same sentence. Keeping only
 * the newest of each kind (the same event about the same thing) leaves
 * room for everything else that happened.
 */
export function homeActivity(
  events: readonly ActivityEvent[],
  names?: Map<string, string>,
  limit = 5,
): Array<DescribedEvent & { id: string; at: string }> {
  const seen = new Set<string>();
  const items: Array<DescribedEvent & { id: string; at: string }> = [];
  for (const event of events) {
    if (HOME_ACTIVITY_EXCLUDED.some((prefix) => event.event.startsWith(prefix)))
      continue;
    const described = describeEvent(event, names, event.entityId);
    const key = `${event.event}|${described.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ id: event.id, at: event.at.toISOString(), ...described });
    if (items.length === limit) break;
  }
  return items;
}
