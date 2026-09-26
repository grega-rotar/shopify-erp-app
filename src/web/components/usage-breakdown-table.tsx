import { useId, useMemo, useState, type ReactNode } from "react";

import { formatShare } from "~/domain/translations/usage";
import { LocaleFlag } from "~/web/components/locale-flag";
import type { BreakdownRowView, ShareBasis } from "~/web/lib/usage";
import {
  formatCost,
  formatCostExact,
  formatRequests,
  formatTokens,
} from "~/web/lib/usage-format";

/**
 * One breakdown of the period — by content type, language, model — as the
 * same table every time (docs/translations.md § AI usage): a name, then
 * tokens, requests, cost and share, the figures right-aligned in tabular
 * numerals so a column can be read down. The numeric columns sort on click;
 * the server already orders by tokens, so that is the opening sort.
 *
 * A long breakdown opens on its first rows with the rest behind "View all",
 * so a card with thirty rows is not a card thirty rows tall. The share is a
 * number with a thin bar beside it: the bar is decoration for the eye, the
 * number is the content, and the bar is hidden from assistive technology.
 */
type SortKey = "totalTokens" | "requests" | "costMicros";

const COLUMNS: ReadonlyArray<{ key: SortKey; label: string }> = [
  { key: "totalTokens", label: "Tokens" },
  { key: "requests", label: "Requests" },
  { key: "costMicros", label: "Cost" },
];

export function UsageBreakdownTable({
  heading,
  column,
  rows,
  shareBasis,
  initialLimit,
  exactCost = false,
  compact = false,
  loading = false,
  empty = "Nothing in this period.",
  footer,
}: {
  heading: string;
  /** The first column's title: "Content type", "Language", "Model". */
  column: string;
  rows: BreakdownRowView[];
  shareBasis: ShareBasis;
  /** Rows shown before "View all"; every row when unset. */
  initialLimit?: number;
  /** Sub-cent costs to four places, for a drill-down; two places otherwise. */
  exactCost?: boolean;
  /** The share as a number alone, for a card too narrow to carry the bar. */
  compact?: boolean;
  loading?: boolean;
  empty?: string;
  footer?: ReactNode;
}) {
  const tipId = `usage-share-tip-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({
    key: "totalTokens",
    desc: true,
  });
  const [all, setAll] = useState(false);

  const sorted = useMemo(
    () =>
      [...rows].sort((a, b) =>
        sort.desc ? b[sort.key] - a[sort.key] : a[sort.key] - b[sort.key],
      ),
    [rows, sort],
  );
  const limit = initialLimit ?? rows.length;
  const shown = all ? sorted : sorted.slice(0, limit);
  const hidden = sorted.length - shown.length;
  const peakShare = Math.max(0, ...rows.map((row) => row.share ?? 0));

  const toggle = (key: SortKey) =>
    setSort((now) =>
      now.key === key ? { key, desc: !now.desc } : { key, desc: true },
    );

  return (
    <s-section heading={heading}>
      {rows.length === 0 && !loading ? (
        <s-text color="subdued">{empty}</s-text>
      ) : (
        <s-stack direction="block" gap="small-300">
          <s-table variant="auto" {...(loading ? { loading: true } : {})}>
            <s-table-header-row>
              <s-table-header listSlot="primary">{column}</s-table-header>
              {COLUMNS.map((col) => (
                <s-table-header
                  key={col.key}
                  format="numeric"
                  {...(col.key === "costMicros"
                    ? { listSlot: "secondary" as const }
                    : {})}
                >
                  <SortHeader
                    label={col.label}
                    active={sort.key === col.key}
                    desc={sort.desc}
                    onClick={() => toggle(col.key)}
                  />
                </s-table-header>
              ))}
              <s-table-header format="numeric">
                {compact ? (
                  "Share"
                ) : (
                  <s-stack
                    direction="inline"
                    gap="small-500"
                    alignItems="center"
                    justifyContent="end"
                  >
                    <s-text>Share</s-text>
                    <s-icon
                      type="info"
                      size="small"
                      color="subdued"
                      interestFor={tipId}
                    />
                    <s-tooltip id={tipId}>
                      {shareBasis === "cost"
                        ? "Of the period's estimated cost."
                        : "Of the period's tokens; nothing in it is priced."}
                    </s-tooltip>
                  </s-stack>
                )}
              </s-table-header>
            </s-table-header-row>
            <s-table-body>
              {shown.map((row) => (
                <s-table-row
                  key={row.key ?? "none"}
                  {...(row.href ? { clickDelegate: `open-${row.key}` } : {})}
                >
                  <s-table-cell>
                    <s-grid
                      gridTemplateColumns={row.flag ? "auto 1fr" : "1fr"}
                      gap="small-300"
                      alignItems="center"
                    >
                      {row.flag ? (
                        <LocaleFlag
                          regionCode={row.flag.regionCode}
                          regionName={row.flag.regionName}
                        />
                      ) : null}
                      <s-stack direction="block" gap="none">
                        {row.href ? (
                          <s-link id={`open-${row.key}`} href={row.href}>
                            {row.name}
                          </s-link>
                        ) : (
                          <s-text>{row.name}</s-text>
                        )}
                        {row.detail ? (
                          <s-text color="subdued">{row.detail}</s-text>
                        ) : null}
                      </s-stack>
                    </s-grid>
                  </s-table-cell>
                  <s-table-cell>
                    <Num>{formatTokens(row.totalTokens)}</Num>
                  </s-table-cell>
                  <s-table-cell>
                    <Num>{formatRequests(row.requests)}</Num>
                  </s-table-cell>
                  <s-table-cell>
                    <Num>
                      {exactCost
                        ? formatCostExact(row.costMicros)
                        : formatCost(row.costMicros)}
                    </Num>
                  </s-table-cell>
                  <s-table-cell>
                    {compact ? (
                      <s-text color="subdued" fontVariantNumeric="tabular-nums">
                        {formatShare(row.share)}
                      </s-text>
                    ) : (
                      <ShareCell share={row.share} peak={peakShare} />
                    )}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>

          {hidden > 0 || all ? (
            <s-box>
              <s-button
                variant="tertiary"
                onClick={() => setAll((now) => !now)}
              >
                {all ? "Show fewer" : `View all ${rows.length}`}
              </s-button>
            </s-box>
          ) : null}
          {footer ? <s-text color="subdued">{footer}</s-text> : null}
        </s-stack>
      )}
    </s-section>
  );
}

/**
 * A column heading that sorts: a button drawn as the heading itself, the
 * way the admin's own index tables do it, with the direction beside the
 * active one. Not a link — a link is blue, and a row of blue headings
 * says "go somewhere" when these only reorder.
 */
export function SortHeader({
  label,
  active,
  desc,
  align = "end",
  onClick,
}: {
  label: string;
  active: boolean;
  desc: boolean;
  /** Where the figures under it sit: the end for a numeric column. */
  align?: "start" | "end";
  onClick: () => void;
}) {
  // In a stack so the button is only as wide as its word and sits where
  // the column's values do.
  return (
    <s-stack direction="inline" justifyContent={align}>
      <s-clickable
        borderRadius="small"
        accessibilityLabel={`Sort by ${label.toLowerCase()}${active ? `, ${desc ? "largest" : "smallest"} first` : ""}`}
        onClick={onClick}
      >
        <s-text type={active ? "strong" : "generic"}>
          {active ? `${label}\u00a0${desc ? "↓" : "↑"}` : label}
        </s-text>
      </s-clickable>
    </s-stack>
  );
}

export function Num({ children }: { children: ReactNode }) {
  return <s-text fontVariantNumeric="tabular-nums">{children}</s-text>;
}

/**
 * The share as a number, with a thin bar scaled to the largest share in the
 * table. The bar is inline SVG in the chart's own ink, so it is the same
 * mark as the chart above it; it is decoration for the eye and hidden from
 * assistive technology, the number being the content.
 */
export function ShareCell({
  share,
  peak,
}: {
  share: number | null;
  peak: number;
}) {
  const fraction = share !== null && peak > 0 ? share / peak : 0;
  const width = share ? Math.max(2, Math.round(fraction * 40)) : 0;
  return (
    <s-grid gridTemplateColumns="1fr 40px" gap="small-300" alignItems="center">
      <s-text color="subdued" fontVariantNumeric="tabular-nums">
        {formatShare(share)}
      </s-text>
      <svg
        width="40"
        height="6"
        viewBox="0 0 40 6"
        aria-hidden="true"
        style={{ display: "block" }}
      >
        <rect
          width="40"
          height="6"
          rx="3"
          fill="var(--s-color-border, #e3e3e3)"
        />
        {width > 0 ? (
          <rect
            width={width}
            height="6"
            rx="3"
            fill="var(--s-color-text, #303030)"
          />
        ) : null}
      </svg>
    </s-grid>
  );
}
