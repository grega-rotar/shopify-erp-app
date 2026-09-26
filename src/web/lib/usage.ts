import {
  DEFAULT_SYNC_SORT,
  DEFAULT_USAGE_PERIOD,
  isSyncSortKey,
  isUsagePeriod,
  type SyncSortKey,
  type TrendBucket,
  type UsagePeriod,
} from "~/domain/translations/usage";

/**
 * The usage page's calendar and address (docs/translations.md § AI usage):
 * where a period starts and ends, which buckets its trend has, and what the
 * page's query string says. Here rather than in `domain/` because it handles
 * dates and URLs; every period is measured in UTC, the clock every `ai_usage`
 * row was stamped in, so "today" is the same day the row says it is.
 * Client-safe: nothing here reads the database.
 */

/** A half-open span: `from` inclusive, `to` exclusive; null is unbounded. */
export interface UsageRange {
  from: Date | null;
  to: Date | null;
}

const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function utcMidnight(date: Date): Date {
  const start = new Date(date);
  start.setUTCHours(0, 0, 0, 0);
  return start;
}

/** `YYYY-MM-DD` as UTC midnight, or null for anything else. */
export function parseIsoDate(value: string | null): Date | null {
  if (!value || !ISO_DATE.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
    ? null
    : date;
}

export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The span a period covers, measured from `now`. A custom period reads its
 * own dates, inclusive on both ends the way a person writes them; a custom
 * period without valid dates falls back to the last thirty days.
 */
export function usagePeriodRange(
  period: UsagePeriod,
  now: Date,
  custom: { from: string | null; to: string | null } = { from: null, to: null },
): UsageRange {
  const today = utcMidnight(now);
  switch (period) {
    case "all":
      return { from: null, to: null };
    case "today":
      return { from: today, to: null };
    case "last7": {
      const from = new Date(today);
      from.setUTCDate(from.getUTCDate() - 6);
      return { from, to: null };
    }
    case "last30": {
      // Thirty days including today, so a month of daily bars is a month wide.
      const from = new Date(today);
      from.setUTCDate(from.getUTCDate() - 29);
      return { from, to: null };
    }
    case "month": {
      const from = new Date(today);
      from.setUTCDate(1);
      return { from, to: null };
    }
    case "previous": {
      const to = new Date(today);
      to.setUTCDate(1);
      const from = new Date(to);
      from.setUTCMonth(from.getUTCMonth() - 1);
      return { from, to };
    }
    case "custom": {
      const from = parseIsoDate(custom.from);
      const toDay = parseIsoDate(custom.to);
      if (!from || !toDay || toDay.getTime() < from.getTime())
        return usagePeriodRange("last30", now);
      const to = new Date(toDay);
      to.setUTCDate(to.getUTCDate() + 1);
      return { from, to };
    }
  }
}

/** The last instant the trend runs to: the end of the range, or now. */
export function trendEnd(range: UsageRange, now: Date): Date {
  if (range.to && range.to.getTime() <= now.getTime())
    return new Date(range.to.getTime() - 1);
  return now;
}

export interface TrendPoint {
  /** The bucket's first instant, ISO. */
  at: string;
  requests: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costMicros: bigint;
}

const EMPTY_POINT = {
  requests: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  costMicros: 0n,
};

/**
 * The trend with a point for every bucket from `from` to `to`, so a day with
 * no requests is an empty slot in the chart rather than a missing bar. `from`
 * null means "from the first point" (all time).
 */
export function fillTrend(
  points: readonly TrendPoint[],
  bucket: TrendBucket,
  from: Date | null,
  to: Date,
): TrendPoint[] {
  const known = new Map(
    points.map((point) => [
      bucketStart(new Date(point.at), bucket).toISOString(),
      point,
    ]),
  );
  const earliest = points[0];
  const first = from ?? (earliest ? new Date(earliest.at) : to);
  const cursor = bucketStart(first, bucket);
  const end = bucketStart(to, bucket);
  const filled: TrendPoint[] = [];
  while (cursor.getTime() <= end.getTime()) {
    const at = cursor.toISOString();
    filled.push(known.get(at) ?? { at, ...EMPTY_POINT });
    if (bucket === "hour") cursor.setUTCHours(cursor.getUTCHours() + 1);
    else if (bucket === "day") cursor.setUTCDate(cursor.getUTCDate() + 1);
    else cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return filled;
}

function bucketStart(at: Date, bucket: TrendBucket): Date {
  const start = new Date(at);
  if (bucket === "hour") {
    start.setUTCMinutes(0, 0, 0);
    return start;
  }
  start.setUTCHours(0, 0, 0, 0);
  if (bucket === "month") start.setUTCDate(1);
  return start;
}

/** How many whole days a range spans, for the range button's label. */
export function rangeDays(range: UsageRange, now: Date): number | null {
  if (!range.from) return null;
  const end = range.to ?? new Date(utcMidnight(now).getTime() + DAY_MS);
  return Math.round((end.getTime() - range.from.getTime()) / DAY_MS);
}

/* -------------------------------------------------------------------------- */
/* The address                                                                */
/* -------------------------------------------------------------------------- */

/** Everything the page's query string decides. */
export interface UsageParams {
  period: UsagePeriod;
  from: string | null;
  to: string | null;
  sort: SyncSortKey;
  desc: boolean;
  page: number;
  locale: string | null;
  mode: string | null;
}

export const SYNC_MODES = ["missing", "missing_outdated", "force"] as const;

/**
 * The query string, read defensively: a period the page does not know is the
 * default, a sort it does not know is the default, a page below one is one.
 */
export function parseUsageParams(search: URLSearchParams): UsageParams {
  const periodParam = search.get("period") ?? DEFAULT_USAGE_PERIOD;
  const period = isUsagePeriod(periodParam)
    ? periodParam
    : DEFAULT_USAGE_PERIOD;
  const sortParam = search.get("sort") ?? DEFAULT_SYNC_SORT.key;
  const sort = isSyncSortKey(sortParam) ? sortParam : DEFAULT_SYNC_SORT.key;
  const dir = search.get("dir");
  const page = Number.parseInt(search.get("page") ?? "1", 10);
  const locale = (search.get("locale") ?? "").trim();
  const mode = search.get("mode") ?? "";
  return {
    period,
    from: period === "custom" ? search.get("from") : null,
    to: period === "custom" ? search.get("to") : null,
    sort,
    desc:
      dir === "asc" ? false : dir === "desc" ? true : DEFAULT_SYNC_SORT.desc,
    page: Number.isFinite(page) && page >= 1 ? page : 1,
    locale: /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(locale) ? locale : null,
    mode: (SYNC_MODES as readonly string[]).includes(mode) ? mode : null,
  };
}

/**
 * The address for a set of params, with defaults left out so the plain page
 * stays `/app/translations/usage`. A change of period or filter starts from
 * the first page; only paging itself carries a page number.
 */
export function usageUrl(base: string, params: Partial<UsageParams>): string {
  const search = new URLSearchParams();
  const period = params.period ?? DEFAULT_USAGE_PERIOD;
  if (period !== DEFAULT_USAGE_PERIOD) search.set("period", period);
  if (period === "custom") {
    if (params.from) search.set("from", params.from);
    if (params.to) search.set("to", params.to);
  }
  const sort = params.sort ?? DEFAULT_SYNC_SORT.key;
  const desc = params.desc ?? DEFAULT_SYNC_SORT.desc;
  if (sort !== DEFAULT_SYNC_SORT.key || desc !== DEFAULT_SYNC_SORT.desc) {
    search.set("sort", sort);
    search.set("dir", desc ? "desc" : "asc");
  }
  if (params.locale) search.set("locale", params.locale);
  if (params.mode) search.set("mode", params.mode);
  if ((params.page ?? 1) > 1) search.set("page", String(params.page));
  const query = search.toString();
  return query ? `${base}?${query}` : base;
}

/** The key the dialog uses for requests outside any sync. */
export const OUTSIDE_SYNC = "none";

/**
 * The address the dialog reads one sync's detail from: the page's own
 * loader, asked for `part=sync`. The period travels with it so the rows
 * outside any sync are the period's, the way the ledger showed them.
 */
export function syncDetailUrl(
  base: string,
  params: Pick<UsageParams, "period" | "from" | "to">,
  syncId: string | null,
): string {
  const url = new URL(usageUrl(base, params), "http://placeholder");
  url.searchParams.set("part", "sync");
  url.searchParams.set("sync", syncId ?? OUTSIDE_SYNC);
  return `${url.pathname}${url.search}`;
}

/* -------------------------------------------------------------------------- */
/* What the page shows                                                        */
/* -------------------------------------------------------------------------- */

/** The sums for one scope, as the loader hands them over. */
export interface UsageTotalsView {
  requests: number;
  failed: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Micro-USD as a number: bigint does not survive the loader. */
  costMicros: number;
  /** Requests whose model is not in the pricing table, so the cost is short. */
  unpriced: number;
  /** Distinct resources translated. */
  resources: number;
}

/** What a share is a share of: cost when anything is priced, else tokens. */
export type ShareBasis = "cost" | "tokens";

export interface BreakdownRowView {
  key: string | null;
  name: string;
  detail: string | null;
  href: string | null;
  /** The region whose flag stands beside a language row. */
  flag: { regionCode: string | null; regionName: string | null } | null;
  requests: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costMicros: number;
  share: number | null;
}

export interface TrendPointView {
  at: string;
  requests: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costMicros: number;
}

export interface SyncRowView {
  /** The sync, or null for requests outside any sync (language detection). */
  id: string | null;
  name: string;
  status: string | null;
  mode: string | null;
  languages: Array<{
    locale: string;
    name: string;
    regionCode: string | null;
    regionName: string | null;
  }>;
  /** Resources translated by the sync's own count, when it exists. */
  doneResources: number | null;
  /** Distinct resources the provider answered for. */
  resources: number;
  startedAt: string;
  requests: number;
  totalTokens: number;
  costMicros: number;
  unpriced: number;
  share: number | null;
}

export interface SyncRequestView {
  id: string;
  at: string;
  purpose: string;
  resourceType: string | null;
  resourceLabel: string | null;
  targetLocale: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costMicros: number | null;
  result: string;
  errorMessage: string | null;
}

/** One sync's usage, read on demand for the dialog. */
export interface SyncDetailView {
  /** Null for requests outside any sync, or a sync that no longer exists. */
  sync: {
    id: string;
    name: string;
    status: string;
    mode: string;
    sourceLocale: string;
    languages: SyncRowView["languages"];
    totalResources: number;
    doneResources: number;
    translatedFields: number;
    failedFields: number;
    createdAt: string;
    finishedAt: string | null;
    href: string;
  } | null;
  totals: UsageTotalsView;
  byType: BreakdownRowView[];
  byLocale: BreakdownRowView[];
  byModel: BreakdownRowView[];
  requests: SyncRequestView[];
  shareBasis: ShareBasis;
}

/** Everything the page renders, as the loader hands it over. */
export interface UsagePageView {
  params: UsageParams;
  range: { from: string | null; toInclusive: string };
  totals: UsageTotalsView;
  shareBasis: ShareBasis;
  bucket: TrendBucket;
  trend: TrendPointView[];
  byLocale: BreakdownRowView[];
  byType: BreakdownRowView[];
  byModel: BreakdownRowView[];
  syncs: { rows: SyncRowView[]; total: number; pageSize: number };
  languages: Array<{ locale: string; name: string }>;
  model: string;
  modelPriced: boolean;
  pricingVersion: string;
}
