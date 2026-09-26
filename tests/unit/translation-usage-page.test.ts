import { describe, expect, it } from "vitest";

import {
  DEFAULT_USAGE_PERIOD,
  formatShare,
  isSyncSortKey,
  isUsagePeriod,
  sharePercent,
  trendBucketFor,
} from "~/domain/translations/usage";
import {
  fillTrend,
  parseUsageParams,
  rangeDays,
  syncDetailUrl,
  trendEnd,
  usagePeriodRange,
  usageUrl,
} from "~/web/lib/usage";
import {
  formatBucketTitle,
  formatCost,
  formatCostExact,
  formatDateSpan,
  formatRequests,
  formatTokens,
} from "~/web/lib/usage-format";

/**
 * The usage page's periods, trend buckets, address, figures and shares
 * (docs/translations.md § AI usage).
 */

const now = new Date("2026-09-20T15:42:00Z");

describe("usage periods", () => {
  it("starts today, the last week and month, and this month at UTC midnight, open-ended", () => {
    expect(usagePeriodRange("today", now)).toEqual({
      from: new Date("2026-09-20T00:00:00Z"),
      to: null,
    });
    // Seven and thirty days including today.
    expect(usagePeriodRange("last7", now).from?.toISOString()).toBe(
      "2026-09-14T00:00:00.000Z",
    );
    expect(usagePeriodRange("last30", now).from?.toISOString()).toBe(
      "2026-08-22T00:00:00.000Z",
    );
    expect(usagePeriodRange("month", now).from?.toISOString()).toBe(
      "2026-09-01T00:00:00.000Z",
    );
    expect(usagePeriodRange("all", now)).toEqual({ from: null, to: null });
  });

  it("closes the previous month at the first of this one, across a year boundary too", () => {
    expect(usagePeriodRange("previous", now)).toEqual({
      from: new Date("2026-08-01T00:00:00Z"),
      to: new Date("2026-09-01T00:00:00Z"),
    });
    expect(
      usagePeriodRange("previous", new Date("2027-01-10T08:00:00Z")),
    ).toEqual({
      from: new Date("2026-12-01T00:00:00Z"),
      to: new Date("2027-01-01T00:00:00Z"),
    });
  });

  it("reads a custom span inclusively and falls back when the dates make no sense", () => {
    expect(
      usagePeriodRange("custom", now, { from: "2026-09-01", to: "2026-09-10" }),
    ).toEqual({
      from: new Date("2026-09-01T00:00:00Z"),
      to: new Date("2026-09-11T00:00:00Z"),
    });
    const fallback = usagePeriodRange("last30", now);
    expect(
      usagePeriodRange("custom", now, { from: "2026-09-10", to: "2026-09-01" }),
    ).toEqual(fallback);
    expect(
      usagePeriodRange("custom", now, { from: "2026-02-31", to: "2026-03-01" }),
    ).toEqual(fallback);
    expect(usagePeriodRange("custom", now, { from: null, to: null })).toEqual(
      fallback,
    );
  });

  it("only accepts a period it knows", () => {
    expect(isUsagePeriod("month")).toBe(true);
    expect(isUsagePeriod("previous")).toBe(true);
    expect(isUsagePeriod("yesterday")).toBe(false);
    expect(DEFAULT_USAGE_PERIOD).toBe("last30");
  });

  it("buckets the trend to fit the span: hours for a day, days for a season, months beyond", () => {
    expect(trendBucketFor(usagePeriodRange("today", now).from, now)).toBe(
      "hour",
    );
    expect(trendBucketFor(usagePeriodRange("last7", now).from, now)).toBe(
      "day",
    );
    expect(trendBucketFor(usagePeriodRange("last30", now).from, now)).toBe(
      "day",
    );
    expect(trendBucketFor(new Date("2026-01-01T00:00:00Z"), now)).toBe("month");
    expect(trendBucketFor(null, now)).toBe("month");
  });

  it("runs the trend to the end of a closed span and to now for an open one", () => {
    expect(trendEnd(usagePeriodRange("previous", now), now).toISOString()).toBe(
      "2026-08-31T23:59:59.999Z",
    );
    expect(trendEnd(usagePeriodRange("last7", now), now)).toEqual(now);
    expect(rangeDays(usagePeriodRange("last7", now), now)).toBe(7);
    expect(rangeDays(usagePeriodRange("previous", now), now)).toBe(31);
    expect(rangeDays(usagePeriodRange("all", now), now)).toBeNull();
  });
});

describe("trend", () => {
  const point = (at: string, requests: number) => ({
    at,
    requests,
    inputTokens: requests * 80,
    cachedInputTokens: requests * 20,
    outputTokens: requests * 20,
    totalTokens: requests * 100,
    costMicros: BigInt(requests * 10),
  });

  it("fills the days nobody translated on, so the chart keeps its calendar", () => {
    const filled = fillTrend(
      [
        point("2026-09-02T00:00:00.000Z", 3),
        point("2026-09-04T00:00:00.000Z", 1),
      ],
      "day",
      new Date("2026-09-01T00:00:00Z"),
      new Date("2026-09-05T10:00:00Z"),
    );
    expect(filled.map((p) => [p.at.slice(0, 10), p.requests])).toEqual([
      ["2026-09-01", 0],
      ["2026-09-02", 3],
      ["2026-09-03", 0],
      ["2026-09-04", 1],
      ["2026-09-05", 0],
    ]);
    expect(filled[1]?.cachedInputTokens).toBe(60);
  });

  it("fills a day by the hour", () => {
    const filled = fillTrend(
      [point("2026-09-20T09:00:00.000Z", 2)],
      "hour",
      new Date("2026-09-20T00:00:00Z"),
      new Date("2026-09-20T15:42:00Z"),
    );
    expect(filled).toHaveLength(16);
    expect(filled[9]?.requests).toBe(2);
    expect(filled[15]?.at).toBe("2026-09-20T15:00:00.000Z");
  });

  it("runs all time from the first month with usage to the current one", () => {
    const filled = fillTrend(
      [point("2026-06-01T00:00:00.000Z", 9)],
      "month",
      null,
      new Date("2026-09-20T00:00:00Z"),
    );
    expect(filled.map((p) => p.at.slice(0, 7))).toEqual([
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
    ]);
    expect(
      fillTrend([], "month", null, new Date("2026-09-20T00:00:00Z")),
    ).toHaveLength(1);
  });
});

describe("address", () => {
  it("reads the query string defensively", () => {
    const params = parseUsageParams(
      new URLSearchParams(
        "period=previous&sort=cost&dir=asc&page=3&locale=sl&mode=force",
      ),
    );
    expect(params).toEqual({
      period: "previous",
      from: null,
      to: null,
      sort: "cost",
      desc: false,
      page: 3,
      locale: "sl",
      mode: "force",
    });
    const junk = parseUsageParams(
      new URLSearchParams(
        "period=never&sort=colour&page=-2&locale=%3Cb%3E&mode=all&from=2026-09-01",
      ),
    );
    expect(junk).toEqual({
      period: "last30",
      from: null,
      to: null,
      sort: "started",
      desc: true,
      page: 1,
      locale: null,
      mode: null,
    });
    expect(
      parseUsageParams(
        new URLSearchParams("period=custom&from=2026-09-01&to=2026-09-10"),
      ).from,
    ).toBe("2026-09-01");
    expect(isSyncSortKey("tokens")).toBe(true);
    expect(isSyncSortKey("name")).toBe(false);
  });

  it("leaves the defaults out of the address and round-trips the rest", () => {
    const base = "/app/translations/usage";
    expect(usageUrl(base, {})).toBe(base);
    expect(
      usageUrl(base, {
        period: "last30",
        sort: "started",
        desc: true,
        page: 1,
      }),
    ).toBe(base);
    const full = usageUrl(base, {
      period: "custom",
      from: "2026-09-01",
      to: "2026-09-10",
      sort: "cost",
      desc: false,
      page: 2,
      locale: "de",
      mode: "missing",
    });
    expect(parseUsageParams(new URL(full, "http://x").searchParams)).toEqual({
      period: "custom",
      from: "2026-09-01",
      to: "2026-09-10",
      sort: "cost",
      desc: false,
      page: 2,
      locale: "de",
      mode: "missing",
    });
    // A period change is not a page change: the custom dates only travel with "custom".
    expect(
      usageUrl(base, { period: "month", from: "2026-09-01", to: "2026-09-10" }),
    ).toBe(`${base}?period=month`);
  });

  it("asks the loader for one sync's detail with the period alongside", () => {
    const base = "/app/translations/usage";
    expect(
      syncDetailUrl(base, { period: "last30", from: null, to: null }, "abc"),
    ).toBe(`${base}?part=sync&sync=abc`);
    expect(
      syncDetailUrl(base, { period: "previous", from: null, to: null }, null),
    ).toBe(`${base}?period=previous&part=sync&sync=none`);
  });
});

describe("figures", () => {
  it("writes every kind of figure one way", () => {
    expect(formatTokens(19_000_000)).toBe("19M");
    expect(formatTokens(1_800_000)).toBe("1.8M");
    expect(formatTokens(424_000)).toBe("424K");
    expect(formatRequests(25_389)).toBe("25,389");
    expect(formatCost(8_070_000)).toBe("$8.07");
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(1_900)).toBe("<$0.01");
    expect(formatCost("5900")).toBe("$0.01");
    expect(formatCost(null)).toBe("—");
    expect(formatCostExact(1_900)).toBe("$0.0019");
    expect(formatCostExact("1900")).toBe("$0.0019");
  });

  it("names a bucket and a span in UTC, in the viewer's own locale", () => {
    // The wording is the runtime locale's; what is asserted is the UTC day and hour.
    expect(formatBucketTitle("2026-09-20T14:00:00.000Z", "hour")).toMatch(
      /20.*14:00 UTC/,
    );
    expect(formatBucketTitle("2026-09-20T23:30:00.000Z", "day")).toMatch(
      /20.*2026|2026.*20/,
    );
    expect(formatBucketTitle("2026-09-01T00:00:00.000Z", "month")).toMatch(
      /September 2026/,
    );
    const span = formatDateSpan(
      new Date("2026-08-22T00:00:00Z"),
      new Date("2026-09-20T00:00:00Z"),
    );
    expect(span).toContain("22");
    expect(span).toContain("20");
    expect(span).toMatch(/ – .*2026$/);
    expect(span.match(/2026/g)).toHaveLength(1);
  });
});

describe("share", () => {
  it("is a percentage with one decimal, never zero for a row that cost something, and nothing of nothing", () => {
    expect(sharePercent(25n, 100n)).toBe(25);
    expect(sharePercent(1, 3)).toBe(33.3);
    expect(sharePercent(1n, 100_000n)).toBe(0.1);
    expect(sharePercent(0n, 100n)).toBe(0);
    expect(sharePercent(5n, 0n)).toBeNull();
    expect(formatShare(25)).toBe("25%");
    expect(formatShare(33.3)).toBe("33.3%");
    expect(formatShare(null)).toBe("—");
  });
});
