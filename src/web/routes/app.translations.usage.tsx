import { boundary } from "@shopify/shopify-app-react-router/server";
import { useCallback } from "react";
import {
  useLoaderData,
  useNavigate,
  useNavigation,
  useRevalidator,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { translationModel } from "~/adapters/ai/openai.server";
import {
  getSync,
  usageBreakdown,
  usageBySync,
  usageRequests,
  usageTotals,
  usageTrend,
  type SyncUsageRow,
  type UsageBreakdownRow,
  type UsageScope,
  type UsageTotals,
} from "~/adapters/db/repositories/translations.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { describeLanguage } from "~/domain/translations/languages";
import { PRICING_VERSION, pricingFor } from "~/domain/translations/pricing";
import {
  RESOURCE_TYPE_LABEL,
  isResourceType,
} from "~/domain/translations/types";
import {
  SYNC_PAGE_SIZE,
  sharePercent,
  trendBucketFor,
} from "~/domain/translations/usage";
import { UsagePage } from "~/web/components/usage-page";
import { principalFromSession } from "~/web/lib/principal.server";
import {
  SYNC_KIND_LABEL,
  syncName,
  TRANSLATION_ROUTES,
  describeResourceId,
} from "~/web/lib/translations";
import {
  OUTSIDE_SYNC,
  fillTrend,
  parseUsageParams,
  syncDetailUrl,
  toIsoDate,
  trendEnd,
  usagePeriodRange,
  usageUrl,
  type BreakdownRowView,
  type ShareBasis,
  type SyncDetailView,
  type SyncRowView,
  type UsagePageView,
  type UsageTotalsView,
} from "~/web/lib/usage";

/**
 * AI usage (docs/translations.md § AI usage): what the provider was asked,
 * what it answered with, and what that is estimated to cost — for one
 * period at a time, the last thirty days by default — as a strip of
 * figures, a chart, three breakdowns and a ledger of syncs that opens
 * into one sync's detail.
 *
 * Every figure is a sum over `ai_usage` rows, one per request the provider
 * saw. Cost is always "estimated": the provider reports tokens, not money,
 * and the price per token is this app's table (`domain/translations/pricing`)
 * at the version each row was priced under. The sums are the repository's;
 * this page only decides the period and the shape.
 *
 * The loader answers two questions: the page (`kind: "page"`) and, for
 * `?part=sync&sync=<id>`, one sync's detail (`kind: "sync"`) read by the
 * dialog on demand, so the page never carries every sync's breakdowns.
 */
function totalsView(totals: UsageTotals): UsageTotalsView {
  return {
    requests: totals.requests,
    failed: totals.failed,
    inputTokens: totals.inputTokens,
    cachedInputTokens: totals.cachedInputTokens,
    outputTokens: totals.outputTokens,
    totalTokens: totals.totalTokens,
    costMicros: Number(totals.costMicros),
    unpriced: totals.unpriced,
    resources: totals.resources,
  };
}

/** A share of the scope: of its cost when anything is priced, else of its tokens. */
function shareOf(totals: UsageTotals): {
  basis: ShareBasis;
  share: (row: { costMicros: bigint; totalTokens: number }) => number | null;
} {
  if (totals.costMicros > 0n)
    return {
      basis: "cost",
      share: (row) => sharePercent(row.costMicros, totals.costMicros),
    };
  return {
    basis: "tokens",
    share: (row) => sharePercent(row.totalTokens, totals.totalTokens),
  };
}

type Describe = (
  key: string | null,
) => Pick<BreakdownRowView, "name" | "detail" | "href"> &
  Partial<Pick<BreakdownRowView, "flag">>;

function rowsView(
  rows: UsageBreakdownRow[],
  share: (row: UsageBreakdownRow) => number | null,
  describe: Describe,
): BreakdownRowView[] {
  return rows.map((row) => ({
    key: row.key,
    flag: null,
    ...describe(row.key),
    requests: row.requests,
    inputTokens: row.inputTokens,
    cachedInputTokens: row.cachedInputTokens,
    outputTokens: row.outputTokens,
    totalTokens: row.totalTokens,
    costMicros: Number(row.costMicros),
    share: share(row),
  }));
}

function languageOf(locale: string): SyncRowView["languages"][number] {
  const language = describeLanguage(locale);
  return {
    locale,
    name: language.name,
    regionCode: language.regionCode,
    regionName: language.regionName,
  };
}

const describeLocale: Describe = (key) => {
  if (!key) return { name: "—", detail: null, href: null };
  const language = describeLanguage(key);
  return {
    name: language.name,
    detail: key,
    href: TRANSLATION_ROUTES.language(key),
    flag: { regionCode: language.regionCode, regionName: language.regionName },
  };
};

const describeType: Describe = (key) => ({
  name:
    key && isResourceType(key)
      ? RESOURCE_TYPE_LABEL[key]
      : (key ?? "Language detection"),
  detail: null,
  href: null,
});

/** "$0.40 in · $0.10 cached · $1.60 out per 1M": what the model's tokens cost. */
function describeRates(model: string): string {
  const pricing = pricingFor(model);
  if (!pricing) return "Not in the pricing table";
  const perMillion = (micros: number) =>
    `$${micros.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 3 })}`;
  return `${perMillion(pricing.inputPerToken)} in · ${perMillion(pricing.cachedInputPerToken)} cached · ${perMillion(pricing.outputPerToken)} out per 1M tokens`;
}

const describeModel: Describe = (key) => ({
  name: key ?? "—",
  detail: key ? describeRates(key) : null,
  href: null,
});

function syncRowView(
  row: SyncUsageRow,
  share: (row: { costMicros: bigint; totalTokens: number }) => number | null,
): SyncRowView {
  return {
    id: row.syncId,
    name: row.kind
      ? (SYNC_KIND_LABEL[row.kind] ?? row.kind)
      : row.syncId
        ? "Sync no longer exists"
        : "Outside a sync",
    status: row.status,
    mode: row.mode,
    languages: row.targetLocales.map(languageOf),
    doneResources: row.doneResources,
    resources: row.resources,
    startedAt: row.startedAt.toISOString(),
    requests: row.requests,
    totalTokens: row.totalTokens,
    costMicros: Number(row.costMicros),
    unpriced: row.unpriced,
    share: share(row),
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const url = new URL(request.url);
  const params = parseUsageParams(url.searchParams);
  const now = new Date();
  const range = usagePeriodRange(params.period, now, {
    from: params.from,
    to: params.to,
  });

  // The small read: one sync for the dialog, nothing for the page.
  if (url.searchParams.get("part") === "sync") {
    const syncKey = url.searchParams.get("sync") ?? OUTSIDE_SYNC;
    const scope: UsageScope =
      syncKey === OUTSIDE_SYNC
        ? { ...range, outsideSync: true }
        : { syncId: syncKey };
    const [sync, totals, byType, byLocale, byModel, requests] =
      await Promise.all([
        syncKey === OUTSIDE_SYNC ? null : getSync(principal, syncKey),
        usageTotals(principal, scope),
        usageBreakdown(principal, "resourceType", scope),
        usageBreakdown(principal, "targetLocale", scope),
        usageBreakdown(principal, "model", scope),
        usageRequests(principal, scope, 50),
      ]);
    const { basis, share } = shareOf(totals);
    const detail: SyncDetailView = {
      sync: sync
        ? {
            id: sync.id,
            name: syncName({
              kind: sync.kind,
              requestedBy: sync.requestedBy,
              resources: sync.resourceIds.length,
            }),
            status: sync.status,
            mode: sync.mode,
            sourceLocale: sync.sourceLocale,
            languages: sync.targetLocales.map(languageOf),
            totalResources: sync.totalResources,
            doneResources: sync.doneResources,
            translatedFields: sync.translatedFields,
            failedFields: sync.failedFields,
            createdAt: sync.createdAt.toISOString(),
            finishedAt: sync.finishedAt?.toISOString() ?? null,
            href: TRANSLATION_ROUTES.sync(sync.id),
          }
        : null,
      totals: totalsView(totals),
      byType: rowsView(byType, share, describeType),
      byLocale: rowsView(byLocale, share, describeLocale),
      byModel: rowsView(byModel, share, describeModel),
      requests: requests.map((row) => ({
        id: row.id,
        at: row.createdAt.toISOString(),
        purpose: row.purpose,
        resourceType: row.resourceType,
        resourceLabel: row.resourceId
          ? describeResourceId(row.resourceId)
          : null,
        targetLocale: row.targetLocale,
        model: row.model,
        inputTokens: row.inputTokens,
        cachedInputTokens: row.cachedInputTokens,
        outputTokens: row.outputTokens,
        totalTokens: row.totalTokens,
        costMicros:
          row.estimatedCostMicros === null
            ? null
            : Number(row.estimatedCostMicros),
        result: row.result,
        errorMessage: row.errorMessage,
      })),
      shareBasis: basis,
    };
    return { kind: "sync" as const, syncKey, detail };
  }

  const scope: UsageScope = range;
  const bucket = trendBucketFor(range.from, now);
  const [totals, byLocale, byModel, byType, syncs, trend] = await Promise.all([
    usageTotals(principal, scope),
    usageBreakdown(principal, "targetLocale", scope),
    usageBreakdown(principal, "model", scope),
    usageBreakdown(principal, "resourceType", scope),
    usageBySync(principal, scope, {
      sort: params.sort,
      desc: params.desc,
      page: params.page,
      pageSize: SYNC_PAGE_SIZE,
      locale: params.locale,
      mode:
        params.mode === "missing" ||
        params.mode === "missing_outdated" ||
        params.mode === "force"
          ? params.mode
          : null,
    }),
    usageTrend(principal, scope, bucket),
  ]);
  const { basis, share } = shareOf(totals);
  const model = translationModel();
  const end = trendEnd(range, now);

  const page: UsagePageView = {
    params,
    range: {
      from: range.from ? toIsoDate(range.from) : null,
      // Inclusive, the way the button names it.
      toInclusive: toIsoDate(end),
    },
    totals: totalsView(totals),
    shareBasis: basis,
    bucket,
    trend: fillTrend(
      trend.map((row) => ({
        at: row.at.toISOString(),
        requests: row.requests,
        inputTokens: row.inputTokens,
        cachedInputTokens: row.cachedInputTokens,
        outputTokens: row.outputTokens,
        totalTokens: row.totalTokens,
        costMicros: row.costMicros,
      })),
      bucket,
      range.from,
      end,
    ).map((point) => ({ ...point, costMicros: Number(point.costMicros) })),
    byLocale: rowsView(byLocale, share, describeLocale),
    byType: rowsView(byType, share, describeType),
    byModel: rowsView(byModel, share, describeModel),
    syncs: {
      rows: syncs.rows.map((row) => syncRowView(row, share)),
      total: syncs.total,
      pageSize: SYNC_PAGE_SIZE,
    },
    languages: byLocale.flatMap((row) =>
      row.key
        ? [{ locale: row.key, name: describeLanguage(row.key).name }]
        : [],
    ),
    model,
    modelPriced: pricingFor(model) !== null,
    pricingVersion: PRICING_VERSION,
  };
  return { kind: "page" as const, ...page };
};

export default function Usage() {
  const data = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const revalidator = useRevalidator();

  const detailUrl = useCallback(
    (row: SyncRowView) =>
      data.kind === "page"
        ? syncDetailUrl(TRANSLATION_ROUTES.usage, data.params, row.id)
        : TRANSLATION_ROUTES.usage,
    [data],
  );

  if (data.kind !== "page") return null;

  return (
    <UsagePage
      data={data}
      loading={
        navigation.state === "loading" &&
        navigation.location.pathname === TRANSLATION_ROUTES.usage
      }
      refreshing={revalidator.state === "loading"}
      onParams={(patch) =>
        void navigate(
          usageUrl(TRANSLATION_ROUTES.usage, { ...data.params, ...patch }),
        )
      }
      onRefresh={() => void revalidator.revalidate()}
      detailUrl={detailUrl}
    />
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
