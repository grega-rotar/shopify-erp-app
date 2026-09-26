import { afterAll, beforeAll, expect, it } from "vitest";

import {
  appendToCollectingSync,
  beginSyncPass,
  createSync,
  deleteSync,
  getSync,
  recordOwnership,
  wroteResourceSince,
} from "~/adapters/db/repositories/translations.server";
import {
  createTenant,
  describeDatabase,
  destroyTenant,
  type TestTenant,
} from "./harness";

/**
 * Changed products are collected into one sync while it is queued
 * (docs/translations.md § Automatic translation). Whether a product lands
 * on the list, is refused once the sync runs, and whether the pass that
 * claims the sync sees the whole list, are conditional updates in
 * PostgreSQL — not something a mock would demonstrate.
 */
describeDatabase("collecting sync", () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTenant("collect");
  });
  afterAll(async () => {
    await destroyTenant(tenant);
  });

  const product = (n: number) => `gid://shopify/Product/${n}`;

  it("adds to the queued sync for the same languages and mode, once per product", async () => {
    const sync = await createSync(tenant.principal, {
      kind: "resource",
      mode: "missing",
      sourceLocale: "en",
      targetLocales: ["de", "sl"],
      resourceTypes: ["PRODUCT"],
      resourceIds: [product(1)],
      requestedBy: null,
    });
    expect(sync.totalResources).toBe(1);

    const second = await appendToCollectingSync(tenant.principal, {
      resourceId: product(2),
      resourceType: "PRODUCT",
      mode: "missing",
      targetLocales: ["de", "sl"],
    });
    expect(second).toMatchObject({ added: true, sync: { id: sync.id } });

    const again = await appendToCollectingSync(tenant.principal, {
      resourceId: product(2),
      resourceType: "PRODUCT",
      mode: "missing",
      targetLocales: ["de", "sl"],
    });
    expect(again).toMatchObject({ added: false, sync: { id: sync.id } });

    const stored = await getSync(tenant.principal, sync.id);
    expect(stored?.resourceIds).toEqual([product(1), product(2)]);
    expect(stored?.totalResources).toBe(2);

    // A different mode or language set is a different sync.
    expect(
      await appendToCollectingSync(tenant.principal, {
        resourceId: product(3),
        resourceType: "PRODUCT",
        mode: "missing_outdated",
        targetLocales: ["de", "sl"],
      }),
    ).toBeNull();
    expect(
      await appendToCollectingSync(tenant.principal, {
        resourceId: product(3),
        resourceType: "PRODUCT",
        mode: "missing",
        targetLocales: ["sl"],
      }),
    ).toBeNull();

    // Once claimed, the pass sees the whole list and nothing more is added.
    const claimed = await beginSyncPass(tenant.principal, sync.id, new Date());
    expect(claimed?.status).toBe("running");
    expect(claimed?.resourceIds).toEqual([product(1), product(2)]);
    expect(
      await appendToCollectingSync(tenant.principal, {
        resourceId: product(4),
        resourceType: "PRODUCT",
        mode: "missing",
        targetLocales: ["de", "sl"],
      }),
    ).toBeNull();

    await deleteSync(sync.id);
    expect(await getSync(tenant.principal, sync.id)).toBeNull();
  });

  it("ignores a sync a person started from the editor", async () => {
    const sync = await createSync(tenant.principal, {
      kind: "resource",
      mode: "missing",
      sourceLocale: "en",
      targetLocales: ["sl"],
      resourceTypes: ["PRODUCT"],
      resourceIds: [product(9)],
      requestedBy: "someone@example.com",
    });
    expect(
      await appendToCollectingSync(tenant.principal, {
        resourceId: product(10),
        resourceType: "PRODUCT",
        mode: "missing",
        targetLocales: ["sl"],
      }),
    ).toBeNull();
    await deleteSync(sync.id);
  });

  it("knows what it wrote recently, per resource", async () => {
    const now = new Date();
    await recordOwnership(
      tenant.principal,
      [
        {
          resourceId: product(20),
          resourceType: "PRODUCT",
          key: "title",
          locale: "sl",
          owner: "ai",
          valueHash: "h",
          sourceDigest: "d",
          syncId: null,
          writtenBy: null,
        },
      ],
      now,
    );
    const minuteAgo = new Date(now.getTime() - 60_000);
    expect(
      await wroteResourceSince(tenant.principal, product(20), minuteAgo),
    ).toBe(true);
    expect(
      await wroteResourceSince(tenant.principal, product(21), minuteAgo),
    ).toBe(false);
    expect(
      await wroteResourceSince(
        tenant.principal,
        product(20),
        new Date(now.getTime() + 1000),
      ),
    ).toBe(false);
  });
});
