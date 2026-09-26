import { afterAll, beforeAll, expect, it } from "vitest";

import {
  createSync,
  usageBreakdown,
  usageBySync,
  usageRequests,
  usageTotals,
  usageTrend,
  type UsageWrite,
} from "~/adapters/db/repositories/translations.server";
import { prisma } from "~/adapters/db/client.server";
import {
  createTenant,
  describeDatabase,
  destroyTenant,
  type TestTenant,
} from "./harness";

/**
 * The usage page's reads (docs/translations.md § AI usage) are SQL over
 * `ai_usage` — sums, a date-truncated trend and a grouped, joined, paged
 * ledger of syncs — and whether they group, filter, sort and page the way
 * the page assumes is a question for PostgreSQL, not for the TypeScript
 * around it.
 */

describeDatabase("translation usage ledger", () => {
  let tenant: TestTenant;
  let missingSync: string;
  let forceSync: string;

  const base = new Date("2026-09-10T10:00:00Z");
  const at = (hoursLater: number) =>
    new Date(base.getTime() + hoursLater * 3_600_000);

  function request(
    overrides: Partial<UsageWrite> & { syncId: string | null },
  ): UsageWrite {
    return {
      resourceId: "gid://shopify/Product/1",
      resourceType: "PRODUCT",
      sourceLocale: "en",
      targetLocale: "sl",
      purpose: "translate",
      promptVersion: "t1",
      model: "gpt-4.1-mini",
      inputTokens: 1000,
      cachedInputTokens: 400,
      outputTokens: 200,
      totalTokens: 1200,
      result: "ok",
      errorMessage: null,
      pricingVersion: "2026-09",
      estimatedCostMicros: 500,
      ...overrides,
    };
  }

  beforeAll(async () => {
    tenant = await createTenant("usage-ledger");
    const missing = await createSync(tenant.principal, {
      kind: "language",
      mode: "missing",
      sourceLocale: "en",
      targetLocales: ["sl"],
      resourceTypes: ["PRODUCT"],
      requestedBy: null,
    });
    const force = await createSync(tenant.principal, {
      kind: "translate_store",
      mode: "force",
      sourceLocale: "en",
      targetLocales: ["de", "it"],
      resourceTypes: ["PRODUCT", "COLLECTION"],
      requestedBy: null,
    });
    missingSync = missing.id;
    forceSync = force.id;

    const writes: Array<{ write: UsageWrite; at: Date }> = [
      // The missing-only sync: three products into Slovenian, one retried.
      {
        write: request({
          syncId: missingSync,
          resourceId: "gid://shopify/Product/1",
        }),
        at: at(0),
      },
      {
        write: request({
          syncId: missingSync,
          resourceId: "gid://shopify/Product/2",
        }),
        at: at(0.5),
      },
      {
        write: request({
          syncId: missingSync,
          resourceId: "gid://shopify/Product/2",
          result: "failed",
          errorMessage: "The reply was not JSON.",
        }),
        at: at(0.25),
      },
      {
        write: request({
          syncId: missingSync,
          resourceId: "gid://shopify/Product/3",
        }),
        at: at(1),
      },
      // The force sync: German and Italian, a collection, an unpriced model.
      {
        write: request({
          syncId: forceSync,
          targetLocale: "de",
          totalTokens: 6000,
          inputTokens: 5000,
          outputTokens: 1000,
          estimatedCostMicros: 4000,
        }),
        at: at(24),
      },
      {
        write: request({
          syncId: forceSync,
          targetLocale: "it",
          resourceType: "COLLECTION",
          resourceId: "gid://shopify/Collection/9",
          model: "mystery-model",
          pricingVersion: null,
          estimatedCostMicros: null,
        }),
        at: at(25),
      },
      // Outside any sync: language detection.
      {
        write: request({
          syncId: null,
          resourceId: null,
          resourceType: null,
          purpose: "detect",
          estimatedCostMicros: 100,
        }),
        at: at(48),
      },
    ];
    // Written directly rather than through `recordUsage`, which stamps now:
    // the reads under test are about a calendar the test controls.
    for (const { write, at: createdAt } of writes) {
      await prisma.aiUsage.create({
        data: {
          shopId: tenant.shopId,
          ...write,
          estimatedCostMicros:
            write.estimatedCostMicros === null
              ? null
              : BigInt(write.estimatedCostMicros),
          createdAt,
        },
      });
    }
  });

  afterAll(async () => {
    if (tenant) await destroyTenant(tenant);
  });

  it("sums a span, counts failures and prices, and counts a retried resource once", async () => {
    const all = await usageTotals(tenant.principal, {});
    expect(all).toMatchObject({
      requests: 7,
      failed: 1,
      unpriced: 1,
      // Six translate requests over five distinct resources, one retried and one failed.
      resources: 4,
      costMicros: 500n * 4n + 4000n + 100n,
    });
    expect(all.cachedInputTokens).toBe(400 * 7);

    const firstDay = await usageTotals(tenant.principal, {
      from: at(0),
      to: at(24),
    });
    expect(firstDay.requests).toBe(4);

    const oneSync = await usageTotals(tenant.principal, { syncId: forceSync });
    expect(oneSync).toMatchObject({ requests: 2, unpriced: 1, resources: 2 });

    const outside = await usageTotals(tenant.principal, { outsideSync: true });
    expect(outside).toMatchObject({ requests: 1, costMicros: 100n });
  });

  it("breaks a sync down on its own and trends by the hour", async () => {
    const byLocale = await usageBreakdown(tenant.principal, "targetLocale", {
      syncId: forceSync,
    });
    expect(
      byLocale.map((row) => [row.key, row.requests, row.cachedInputTokens]),
    ).toEqual([
      ["de", 1, 400],
      ["it", 1, 400],
    ]);

    const hours = await usageTrend(
      tenant.principal,
      { from: at(0), to: at(2) },
      "hour",
    );
    expect(
      hours.map((row) => [
        row.at.toISOString(),
        row.requests,
        row.cachedInputTokens,
      ]),
    ).toEqual([
      ["2026-09-10T10:00:00.000Z", 3, 1200],
      ["2026-09-10T11:00:00.000Z", 1, 400],
    ]);
  });

  it("lists syncs as one grouped query, joined, filtered, sorted and paged in the database", async () => {
    const byCost = await usageBySync(
      tenant.principal,
      {},
      {
        sort: "cost",
        desc: true,
        page: 1,
        pageSize: 10,
      },
    );
    expect(byCost.total).toBe(3);
    expect(
      byCost.rows.map((row) => [
        row.syncId,
        row.kind,
        row.mode,
        Number(row.costMicros),
        row.resources,
        row.unpriced,
      ]),
    ).toEqual([
      [forceSync, "translate_store", "force", 4000, 2, 1],
      [missingSync, "language", "missing", 2000, 3, 0],
      [null, null, null, 100, 0, 0],
    ]);
    expect(byCost.rows[0]?.targetLocales).toEqual(["de", "it"]);
    // A request outside any sync is dated by its own first request.
    expect(byCost.rows[2]?.startedAt.toISOString()).toBe(at(48).toISOString());

    const paged = await usageBySync(
      tenant.principal,
      {},
      {
        sort: "cost",
        desc: true,
        page: 2,
        pageSize: 2,
      },
    );
    expect(paged.total).toBe(3);
    expect(paged.rows.map((row) => row.syncId)).toEqual([null]);

    const italian = await usageBySync(
      tenant.principal,
      {},
      {
        sort: "tokens",
        desc: true,
        page: 1,
        pageSize: 10,
        locale: "it",
      },
    );
    expect(italian.total).toBe(1);
    expect(italian.rows[0]).toMatchObject({ syncId: forceSync, requests: 1 });

    const missingOnly = await usageBySync(
      tenant.principal,
      {},
      {
        sort: "requests",
        desc: false,
        page: 1,
        pageSize: 10,
        mode: "missing",
      },
    );
    expect(missingOnly.rows.map((row) => row.syncId)).toEqual([missingSync]);

    const inSpan = await usageBySync(
      tenant.principal,
      { from: at(20), to: at(30) },
      {
        sort: "started",
        desc: true,
        page: 1,
        pageSize: 10,
      },
    );
    expect(inSpan.rows.map((row) => row.syncId)).toEqual([forceSync]);
  });

  it("lists a sync's requests newest first", async () => {
    const requests = await usageRequests(
      tenant.principal,
      { syncId: missingSync },
      2,
    );
    expect(requests.map((row) => row.resourceId)).toEqual([
      "gid://shopify/Product/3",
      "gid://shopify/Product/2",
    ]);
    expect(requests[1]?.result).toBe("ok");
  });
});
