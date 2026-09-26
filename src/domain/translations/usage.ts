/**
 * The usage page's vocabulary and arithmetic (docs/translations.md § AI
 * usage): the reporting periods, how the trend is bucketed, how the sync
 * ledger sorts, and a share of a total. Pure: the sums are the repository's,
 * the clock is the web layer's (`web/lib/usage`), and nothing here carries a
 * price.
 */
export const USAGE_PERIODS = [
  "today",
  "last7",
  "last30",
  "month",
  "previous",
  "all",
  "custom",
] as const;
export type UsagePeriod = (typeof USAGE_PERIODS)[number];

export const USAGE_PERIOD_LABEL: Record<UsagePeriod, string> = {
  today: "Today",
  last7: "Last 7 days",
  last30: "Last 30 days",
  month: "This month",
  previous: "Previous month",
  all: "All time",
  custom: "Custom range",
};

/** The period the page opens on: a rolling month, so the 2nd is not empty. */
export const DEFAULT_USAGE_PERIOD: UsagePeriod = "last30";

export function isUsagePeriod(value: string): value is UsagePeriod {
  return (USAGE_PERIODS as readonly string[]).includes(value);
}

export type TrendBucket = "hour" | "day" | "month";

const DAY_MS = 86_400_000;

/**
 * How the trend is bucketed for a span: a bar an hour for a day or two, a
 * bar a day for up to a season, a bar a month beyond that. `from` null is
 * all time, which is always months.
 */
export function trendBucketFor(from: Date | null, to: Date): TrendBucket {
  if (from === null) return "month";
  const days = (to.getTime() - from.getTime()) / DAY_MS;
  if (days <= 2) return "hour";
  if (days <= 100) return "day";
  return "month";
}

/** The columns the sync ledger sorts on. */
export const SYNC_SORT_KEYS = [
  "started",
  "cost",
  "tokens",
  "requests",
  "resources",
] as const;
export type SyncSortKey = (typeof SYNC_SORT_KEYS)[number];

export function isSyncSortKey(value: string): value is SyncSortKey {
  return (SYNC_SORT_KEYS as readonly string[]).includes(value);
}

/** Newest first: the sync a merchant is asking about is usually the last one. */
export const DEFAULT_SYNC_SORT: { key: SyncSortKey; desc: boolean } = {
  key: "started",
  desc: true,
};

/** Rows per page of the sync ledger. */
export const SYNC_PAGE_SIZE = 15;

/**
 * A part of a total as a percentage with one decimal, or null when there is
 * no total to be a share of. A tiny non-zero share rounds to 0.1 rather than
 * 0, so a row that cost something never reads as costing nothing.
 */
export function sharePercent(
  part: bigint | number,
  total: bigint | number,
): number | null {
  const whole = Number(total);
  if (whole <= 0) return null;
  const share = (Number(part) / whole) * 100;
  if (share > 0 && share < 0.1) return 0.1;
  return Math.round(share * 10) / 10;
}

export function formatShare(share: number | null): string {
  if (share === null) return "—";
  return `${Number.isInteger(share) ? share : share.toFixed(1)}%`;
}
