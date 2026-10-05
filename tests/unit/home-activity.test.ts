import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  describeEvent,
  HOME_ACTIVITY_EXCLUDED,
  homeActivity,
  type ActivityEvent,
} from "~/web/lib/activity";

/**
 * Activity in the merchant's words (docs/ui-conventions.md § Element
 * semantics: raw syntax never reaches a merchant). Home once printed
 * `translation_sync.nothing_to_do` as a sentence, because the describer's
 * fallback was the event's own name.
 */

/** Every event name the code writes to `event_log`, read from the source. */
function eventNamesInSource(): string[] {
  const names = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry)) {
        const text = readFileSync(path, "utf8");
        for (const match of text.matchAll(
          /"((?:[a-z_]+)\.(?:[a-z_]+)(?:\.[a-z_]+)?)"/g,
        )) {
          const name = match[1] ?? "";
          if (
            /^(translation|sale|export|order|orders|inventory|catalogue|products?|product_sync|warehouse|supply|profit|payment|metakocka|tax|app|compliance|setup|sales_order|exception|pricelists)[a-z_]*\./.test(
              name,
            )
          )
            names.add(name);
        }
      }
    }
  };
  walk(join(__dirname, "../../src"));
  return [...names];
}

const RAW = /\b[a-z]+_[a-z_]+\b|\b[a-z_]+\.[a-z_]+\b/;

describe("describeEvent", () => {
  const names = eventNamesInSource();

  it("finds the events the code writes", () => {
    expect(names).toContain("translation_sync.nothing_to_do");
    expect(names).toContain("sale_campaign.apply_finished");
    expect(names.length).toBeGreaterThan(50);
  });

  it("never shows an event's raw name, for any event the code writes", () => {
    for (const name of names) {
      const described = describeEvent({ event: name, detail: {} });
      expect(`${described.title} ${described.text}`, name).not.toMatch(RAW);
    }
  });

  it("falls back to the area for an event nobody has worded", () => {
    expect(
      describeEvent({ event: "translation_widget.frobbed", detail: null }),
    ).toEqual({
      title: "Translations",
      text: "An update was recorded.",
      ok: true,
    });
    expect(describeEvent({ event: "mystery", detail: null }).title).toBe(
      "This app",
    );
  });

  it("says a translation sync found nothing to do in words", () => {
    expect(
      describeEvent({ event: "translation_sync.nothing_to_do", detail: {} })
        .text,
    ).toBe(
      "Translation sync checked the store. Everything was already up to date.",
    );
  });

  it("names a campaign by its name", () => {
    const described = describeEvent(
      {
        event: "sale_campaign.apply_finished",
        detail: { counts: { applied: 1284, failed: 0 } },
      },
      new Map([["c1", "Summer Sale"]]),
      "c1",
    );
    expect(described).toEqual({
      title: "Summer Sale",
      text: "Sale prices applied to 1,284 variants.",
      ok: true,
    });
  });
});

describe("homeActivity", () => {
  let id = 0;
  const event = (
    name: string,
    minutesAgo: number,
    entityId: string | null = null,
  ): ActivityEvent => ({
    id: String((id += 1)),
    at: new Date(Date.UTC(2026, 8, 28, 12, 0) - minutesAgo * 60_000),
    event: name,
    entityId,
    detail: {},
  });

  it("keeps the newest of each kind, so one busy job cannot fill the list", () => {
    const items = homeActivity([
      event("translation_sync.nothing_to_do", 1),
      event("translation_sync.nothing_to_do", 2),
      event("translation_sync.nothing_to_do", 3),
      event("catalogue.synced", 4),
      event("translation_sync.completed", 5),
    ]);
    expect(items.map((item) => item.text)).toEqual([
      "Translation sync checked the store. Everything was already up to date.",
      "Read 0 Shopify variants. All 0 found their MetaKocka product.",
      "Translation sync completed.",
    ]);
  });

  it("leaves out per-record events and stops at the limit", () => {
    const items = homeActivity(
      [
        event("order.received", 1),
        event("sale_variant.price_changed", 2),
        ...Array.from({ length: 8 }, (_, index) =>
          event("inventory.synced", 3 + index, `source-${index}`),
        ),
      ],
      new Map(
        Array.from({ length: 8 }, (_, index) => [
          `source-${index}`,
          `Warehouse ${index}`,
        ]),
      ),
    );
    expect(items).toHaveLength(5);
    expect(items.every((item) => item.title.startsWith("Warehouse"))).toBe(
      true,
    );
  });

  it("excludes the same prefixes the query does", () => {
    expect(HOME_ACTIVITY_EXCLUDED).toContain("order.");
    expect(HOME_ACTIVITY_EXCLUDED).not.toContain("orders.");
  });
});
