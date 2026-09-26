import { formatCount } from "~/domain/translations/estimate";
import { formatMicrosUsd } from "~/domain/translations/pricing";
import { formatShare, type TrendBucket } from "~/domain/translations/usage";

/**
 * One way of writing each kind of figure on the usage page, so a token count
 * in a table, a chart tooltip and a dialog never disagree about what 19
 * million looks like. Client-safe.
 */

/** "19M", "1.8M", "424K", "25,389". */
export function formatTokens(value: number): string {
  return formatCount(value);
}

/** "25,389": a request count is never abbreviated. */
export function formatRequests(value: number): string {
  return value.toLocaleString("en");
}

/**
 * "$8.07", "$0.00", "<$0.01" — two places, so a column of costs lines up.
 * The exact sub-cent figure is `formatCostExact`, for a drill-down.
 */
export function formatCost(micros: number | bigint | string | null): string {
  if (micros === null) return "—";
  const value = Number(micros) / 1_000_000;
  if (value !== 0 && Math.abs(value) < 0.005) return "<$0.01";
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** "$0.0059": the exact figure, for one request or one row of a drill-down. */
export function formatCostExact(
  micros: number | bigint | string | null,
): string {
  if (micros === null) return "—";
  return formatMicrosUsd(typeof micros === "string" ? BigInt(micros) : micros);
}

export function formatPercentage(share: number | null): string {
  return formatShare(share);
}

/** A bucket's label on the chart's axis: "20 Sep", "14:00", "Sep 2026". */
export function formatBucketLabel(iso: string, bucket: TrendBucket): string {
  const date = new Date(iso);
  if (bucket === "hour")
    return date.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC",
    });
  if (bucket === "day")
    return date.toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
  return date.toLocaleDateString(undefined, {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** A bucket named in full, for the tooltip: "Sep 20, 2026", "Sep 20, 14:00 UTC". */
export function formatBucketTitle(iso: string, bucket: TrendBucket): string {
  const date = new Date(iso);
  if (bucket === "hour")
    return `${date.toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    })}, ${formatBucketLabel(iso, "hour")} UTC`;
  if (bucket === "day")
    return date.toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  return date.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** "Aug 22 – Sep 20, 2026": a span in one phrase, for the range button. */
export function formatDateSpan(from: Date, toInclusive: Date): string {
  const sameYear = from.getUTCFullYear() === toInclusive.getUTCFullYear();
  const start = from.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  const end = toInclusive.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  return `${start} – ${end}`;
}
