import { describe, expect, it } from "vitest";

import { syncName } from "~/web/lib/translations";

/** A sync's name on the syncs, language and usage pages (docs/translations.md § Syncs). */
describe("syncName", () => {
  it("names a person's editor run and Shopify's collected changes apart", () => {
    expect(
      syncName({ kind: "resource", requestedBy: "a@b.c", resources: 1 }),
    ).toBe("One resource");
    expect(
      syncName({ kind: "resource", requestedBy: null, resources: 1 }),
    ).toBe("One changed product");
    expect(
      syncName({ kind: "resource", requestedBy: null, resources: 1234 }),
    ).toBe("1,234 changed products");
  });

  it("keeps the other kinds' labels", () => {
    expect(
      syncName({ kind: "translate_store", requestedBy: "a@b.c", resources: 0 }),
    ).toBe("Translate store");
    expect(
      syncName({ kind: "automatic", requestedBy: null, resources: 0 }),
    ).toBe("Automatic");
    expect(
      syncName({ kind: "language", requestedBy: null, resources: 0 }),
    ).toBe("Language");
  });
});
