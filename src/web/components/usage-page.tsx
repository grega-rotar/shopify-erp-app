import { useState } from "react";

import {
  USAGE_PERIOD_LABEL,
  type UsagePeriod,
} from "~/domain/translations/usage";
import { TranslationsNav } from "~/web/components/translations-nav";
import { UsageBreakdownTable } from "~/web/components/usage-breakdown-table";
import { UsageChart } from "~/web/components/usage-chart";
import { UsageRangePicker } from "~/web/components/usage-range-picker";
import { UsageSummary } from "~/web/components/usage-summary";
import { UsageSyncModal } from "~/web/components/usage-sync-modal";
import { UsageSyncTable } from "~/web/components/usage-sync-table";
import { TRANSLATION_ROUTES } from "~/web/lib/translations";
import type { SyncRowView, UsagePageView, UsageParams } from "~/web/lib/usage";
import { formatDateSpan } from "~/web/lib/usage-format";

/**
 * The AI usage page as a screen (docs/translations.md § AI usage): the
 * period's figures, the chart, the three breakdowns and the sync ledger,
 * in that order of importance. The route decides what the data is and
 * where the address goes; this decides only what the page looks like, so
 * it can be rendered with any data.
 */
export function UsagePage({
  data,
  loading,
  refreshing,
  onParams,
  onRefresh,
  detailUrl,
}: {
  data: UsagePageView;
  /** A new period or page is on its way. */
  loading: boolean;
  /** The same page is being read again. */
  refreshing: boolean;
  onParams: (patch: Partial<UsageParams>) => void;
  onRefresh: () => void;
  /** Where the dialog reads one sync's detail. */
  detailUrl: (row: SyncRowView) => string;
}) {
  const [openRow, setOpenRow] = useState<SyncRowView | null>(null);
  const { params, totals } = data;
  const empty = totals.requests === 0;
  const rangeLabel =
    params.period === "custom" && data.range.from
      ? formatDateSpan(
          new Date(`${data.range.from}T00:00:00Z`),
          new Date(`${data.range.toInclusive}T00:00:00Z`),
        )
      : USAGE_PERIOD_LABEL[params.period];

  const go = (patch: Partial<UsageParams>) => onParams(patch);

  const choosePeriod = (
    period: UsagePeriod,
    custom?: { from: string; to: string },
  ) =>
    go({
      period,
      from: custom?.from ?? null,
      to: custom?.to ?? null,
      page: 1,
    });

  return (
    <s-page heading="AI usage" inlineSize="large">
      <s-link slot="breadcrumb-actions" href={TRANSLATION_ROUTES.languages}>
        Translations
      </s-link>

      {/*
       * The query container is what the responsive values below measure
       * against: an unnamed `@container (…)` value is compiled against a
       * container called `s-default`, and only `s-query-container` provides
       * one. Without it every breakpoint on this page is dead.
       */}
      <s-query-container>
        <s-stack direction="block" gap="base">
          <TranslationsNav current="usage" />

          {/* What the page is for on the left; when, and again, on the right. */}
          <s-grid
            gridTemplateColumns="@container (inline-size <= 640px) 1fr, 1fr auto"
            gap="base"
            alignItems="center"
          >
            <s-text color="subdued">
              Monitor translation token usage, requests and estimated AI costs.
            </s-text>
            <s-stack direction="inline" gap="small-300" alignItems="center">
              <UsageRangePicker
                period={params.period}
                label={rangeLabel}
                from={params.from}
                to={params.to}
                loading={loading}
                onSelect={choosePeriod}
              />
              <s-button
                variant="tertiary"
                icon="refresh"
                accessibilityLabel="Refresh"
                {...(refreshing ? { loading: true } : {})}
                onClick={onRefresh}
              />
            </s-stack>
          </s-grid>

          {!data.modelPriced ? (
            <s-banner
              tone="warning"
              heading={`${data.model} is not in the pricing table`}
            >
              <s-paragraph>
                Tokens are recorded for every request, but no cost can be
                estimated for this model until its price is added to the table
                (version {data.pricingVersion}).
              </s-paragraph>
            </s-banner>
          ) : null}

          <UsageSummary
            totals={totals}
            pricingVersion={data.pricingVersion}
            loading={loading}
          />

          {empty ? (
            <s-section accessibilityLabel="No usage">
              <s-stack direction="block" gap="small-300" alignItems="start">
                <s-text type="strong">
                  {params.period === "all"
                    ? "No AI requests yet."
                    : `No AI requests in this period.`}
                </s-text>
                <s-text color="subdued">
                  Usage appears here as soon as a translation reaches the
                  provider.
                </s-text>
                {params.period === "all" ? (
                  <s-button
                    variant="secondary"
                    href={TRANSLATION_ROUTES.translate}
                  >
                    Translate store
                  </s-button>
                ) : (
                  <s-button
                    variant="secondary"
                    onClick={() => choosePeriod("all")}
                  >
                    Show all time
                  </s-button>
                )}
              </s-stack>
            </s-section>
          ) : (
            <>
              <s-section heading="Usage over time">
                <UsageChart
                  points={data.trend}
                  bucket={data.bucket}
                  priced={totals.costMicros > 0}
                />
              </s-section>

              {/*
               * One row of three, the cards as tall as the tallest: content
               * takes the widest column because it has the most rows and the
               * longest names, and nothing is stacked beside a short card,
               * so a period with one content type leaves no hole.
               */}
              <s-grid
                gridTemplateColumns="@container (inline-size <= 1280px) 1fr, 'minmax(0, 2fr) minmax(0, 1.5fr) minmax(0, 1.5fr)'"
                gap="base"
                alignItems="stretch"
              >
                <UsageBreakdownTable
                  heading="By content type"
                  column="Content type"
                  rows={data.byType}
                  shareBasis={data.shareBasis}
                  initialLimit={10}
                  loading={loading}
                />
                <UsageBreakdownTable
                  heading="By language"
                  column="Language"
                  rows={data.byLocale}
                  shareBasis={data.shareBasis}
                  initialLimit={10}
                  compact
                  loading={loading}
                />
                <UsageBreakdownTable
                  heading="By model"
                  column="Model"
                  rows={data.byModel}
                  shareBasis={data.shareBasis}
                  compact
                  loading={loading}
                  footer={
                    data.byModel.length === 1
                      ? `Every request in this period went to ${data.byModel[0]?.name ?? "one model"}.`
                      : undefined
                  }
                />
              </s-grid>

              <UsageSyncTable
                rows={data.syncs.rows}
                total={data.syncs.total}
                pageSize={data.syncs.pageSize}
                state={{
                  sort: params.sort,
                  desc: params.desc,
                  page: params.page,
                  locale: params.locale,
                  mode: params.mode,
                }}
                languages={data.languages}
                shareBasis={data.shareBasis}
                loading={loading}
                onChange={(patch) => go(patch)}
                onOpen={setOpenRow}
              />
            </>
          )}
        </s-stack>
      </s-query-container>

      <UsageSyncModal
        row={openRow}
        detailUrl={detailUrl}
        onClose={() => setOpenRow(null)}
      />
    </s-page>
  );
}
