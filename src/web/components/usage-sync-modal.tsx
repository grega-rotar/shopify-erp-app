import { useEffect, useRef } from "react";
import { useFetcher } from "react-router";

import {
  RESOURCE_TYPE_LABEL,
  SYNC_MODE_LABEL,
  isResourceType,
  type SyncMode,
} from "~/domain/translations/types";
import { LocaleFlag } from "~/web/components/locale-flag";
import {
  Num,
  UsageBreakdownTable,
} from "~/web/components/usage-breakdown-table";
import { formatDateTime, formatListDateTime } from "~/web/lib/datetime";
import { SYNC_STATUS_LABEL } from "~/web/lib/translations";
import type { SyncDetailView, SyncRowView } from "~/web/lib/usage";
import {
  formatCost,
  formatCostExact,
  formatRequests,
  formatTokens,
} from "~/web/lib/usage-format";

/**
 * One sync's usage in a dialog over the usage page (docs/translations.md
 * § AI usage): what the sync was, the same five figures the page opens
 * with, the breakdowns by content, language and model for this sync alone,
 * and the last requests one by one — the place a sub-cent cost is written
 * out in full. Read on demand from the page's own loader (`part=sync`), so
 * the page stays one screen and the detail is one click away.
 *
 * The dialog is one element the page keeps; opening a row shows it and
 * starts the read, and it fills in place. Closing tells the page, which
 * forgets the row, so the next opening starts clean.
 */
type Overlay = { showOverlay?: () => void; hideOverlay?: () => void };

export const SYNC_MODAL_ID = "usage-sync-modal";

export function UsageSyncModal({
  row,
  detailUrl,
  onClose,
}: {
  /** The row the dialog is open for, or null while closed. */
  row: SyncRowView | null;
  /** The address that answers with the sync's detail. */
  detailUrl: (row: SyncRowView) => string;
  onClose: () => void;
}) {
  const fetcher = useFetcher<{
    kind: "sync";
    syncKey: string;
    detail: SyncDetailView;
  }>();
  const overlay = useRef<Overlay | null>(null);
  const openFor = useRef<string | null>(null);

  useEffect(() => {
    if (!row) return;
    const key = row.id ?? "none";
    if (openFor.current === key) return;
    openFor.current = key;
    overlay.current?.showOverlay?.();
    void fetcher.load(detailUrl(row));
  }, [row, detailUrl, fetcher]);

  // Only an answer for this row counts: the fetcher still holds the last one.
  const rowKey = row ? (row.id ?? "none") : null;
  const answer = fetcher.state === "idle" ? fetcher.data : undefined;
  const detail =
    rowKey !== null && answer?.kind === "sync" && answer.syncKey === rowKey
      ? answer.detail
      : null;
  const failed =
    rowKey !== null &&
    answer !== undefined &&
    detail === null &&
    (answer.kind !== "sync" || answer.syncKey === rowKey);
  const loading = rowKey !== null && detail === null && !failed;

  const heading = row
    ? `${row.name} · ${formatDateTime(row.startedAt)}`
    : "Sync usage";

  return (
    <s-modal
      id={SYNC_MODAL_ID}
      heading={heading}
      size="large"
      ref={(element) => {
        overlay.current = (element as Overlay | null) ?? null;
      }}
      onAfterHide={() => {
        openFor.current = null;
        onClose();
      }}
    >
      {row === null ? null : loading ? (
        <Skeleton />
      ) : failed ? (
        <s-banner tone="critical" heading="The sync's usage could not be read">
          <s-paragraph>Close the dialog and open the sync again.</s-paragraph>
        </s-banner>
      ) : detail ? (
        <Detail row={row} detail={detail} />
      ) : (
        <Skeleton />
      )}

      {detail?.sync ? (
        <s-button slot="secondary-actions" href={detail.sync.href}>
          Open sync
        </s-button>
      ) : null}
      <s-button
        slot="primary-action"
        variant="primary"
        command="--hide"
        commandFor={SYNC_MODAL_ID}
      >
        Close
      </s-button>
    </s-modal>
  );
}

function Detail({ row, detail }: { row: SyncRowView; detail: SyncDetailView }) {
  const { sync, totals } = detail;
  const models = detail.byModel.map((model) => model.name).join(", ");
  const languages = sync?.languages ?? row.languages;

  // The container the responsive grids measure against; see `UsagePage`.
  return (
    <s-query-container>
      <s-stack direction="block" gap="base">
        {/* What the sync was. */}
        <s-grid
          gridTemplateColumns="@container (inline-size <= 640px) 1fr 1fr, 'repeat(4, minmax(0, 1fr))'"
          gap="base"
          alignItems="start"
        >
          <Fact label="Started" value={formatDateTime(row.startedAt)} />
          <Fact
            label="Status"
            value={
              sync
                ? (SYNC_STATUS_LABEL[sync.status] ?? sync.status)
                : row.id
                  ? "Sync no longer exists"
                  : "Outside a sync"
            }
          />
          <Fact
            label="Mode"
            value={
              sync ? (SYNC_MODE_LABEL[sync.mode as SyncMode] ?? sync.mode) : "—"
            }
          />
          <Fact label="Models" value={models || "—"} />
          <s-stack direction="block" gap="small-500">
            <s-text color="subdued">Languages</s-text>
            {languages.length === 0 ? (
              <s-text>—</s-text>
            ) : (
              <s-stack direction="inline" gap="small-300" alignItems="center">
                {languages.map((language) => (
                  <s-stack
                    key={language.locale}
                    direction="inline"
                    gap="small-400"
                    alignItems="center"
                  >
                    <LocaleFlag
                      regionCode={language.regionCode}
                      regionName={language.regionName}
                      size="small"
                    />
                    <s-text>{language.name}</s-text>
                  </s-stack>
                ))}
              </s-stack>
            )}
          </s-stack>
          <Fact
            label="Resources processed"
            value={
              sync
                ? sync.totalResources > 0
                  ? `${formatRequests(sync.doneResources)} of ${formatRequests(sync.totalResources)}`
                  : formatRequests(sync.doneResources)
                : "—"
            }
          />
          <Fact
            label="Resources translated"
            value={formatRequests(totals.resources)}
            detail={
              sync && sync.failedFields > 0
                ? `${formatRequests(sync.failedFields)} fields failed`
                : sync
                  ? `${formatRequests(sync.translatedFields)} fields`
                  : null
            }
          />
          <Fact
            label="Finished"
            value={sync?.finishedAt ? formatDateTime(sync.finishedAt) : "—"}
          />
        </s-grid>

        <s-divider />

        {/* What it took. */}
        <s-grid
          gridTemplateColumns="@container (inline-size <= 640px) 1fr 1fr, 'repeat(6, minmax(0, 1fr))'"
          gap="base"
          alignItems="start"
        >
          <Fact
            label="Requests"
            value={formatRequests(totals.requests)}
            detail={
              totals.failed > 0
                ? `${formatRequests(totals.failed)} failed`
                : null
            }
            tone={totals.failed > 0 ? "warning" : undefined}
          />
          <Fact label="Input tokens" value={formatTokens(totals.inputTokens)} />
          <Fact
            label="Cached input"
            value={formatTokens(totals.cachedInputTokens)}
            detail="Priced at the cached rate"
          />
          <Fact
            label="Output tokens"
            value={formatTokens(totals.outputTokens)}
          />
          <Fact label="Total tokens" value={formatTokens(totals.totalTokens)} />
          <Fact
            label="Estimated cost"
            value={formatCost(totals.costMicros)}
            detail={
              totals.unpriced > 0
                ? `${formatRequests(totals.unpriced)} requests not priced`
                : totals.costMicros > 0 && totals.costMicros < 10_000
                  ? formatCostExact(totals.costMicros)
                  : null
            }
            tone={totals.unpriced > 0 ? "warning" : undefined}
          />
        </s-grid>

        {/* Where it went. */}
        <s-grid
          gridTemplateColumns="@container (inline-size <= 760px) 1fr, 1fr 1fr"
          gap="base"
          alignItems="start"
        >
          <UsageBreakdownTable
            heading="By content type"
            column="Content type"
            rows={detail.byType}
            shareBasis={detail.shareBasis}
            exactCost
            empty="No requests."
          />
          <s-stack direction="block" gap="base">
            <UsageBreakdownTable
              heading="By language"
              column="Language"
              rows={detail.byLocale}
              shareBasis={detail.shareBasis}
              exactCost
              empty="No requests."
            />
            <UsageBreakdownTable
              heading="By model"
              column="Model"
              rows={detail.byModel}
              shareBasis={detail.shareBasis}
              exactCost
              empty="No requests."
            />
          </s-stack>
        </s-grid>

        <Requests detail={detail} />
      </s-stack>
    </s-query-container>
  );
}

/** The last requests the provider saw for this sync, newest first. */
function Requests({ detail }: { detail: SyncDetailView }) {
  const shown = detail.requests.length;
  const total = detail.totals.requests;
  return (
    <s-section
      heading="Requests"
      accessibilityLabel={`The last ${shown} of ${total} requests`}
    >
      {shown === 0 ? (
        <s-text color="subdued">No requests.</s-text>
      ) : (
        <s-stack direction="block" gap="small-300">
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">Request</s-table-header>
              <s-table-header listSlot="kicker">Time</s-table-header>
              <s-table-header listSlot="inline">Language</s-table-header>
              <s-table-header listSlot="inline">Model</s-table-header>
              <s-table-header format="numeric">Input</s-table-header>
              <s-table-header format="numeric">Cached</s-table-header>
              <s-table-header format="numeric">Output</s-table-header>
              <s-table-header format="numeric" listSlot="secondary">
                Cost
              </s-table-header>
              <s-table-header listSlot="inline">Result</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {detail.requests.map((request) => (
                <s-table-row key={request.id}>
                  <s-table-cell>
                    <s-stack direction="block" gap="none">
                      <s-text>
                        {request.purpose === "translate"
                          ? request.resourceType &&
                            isResourceType(request.resourceType)
                            ? RESOURCE_TYPE_LABEL[request.resourceType]
                            : (request.resourceType ?? "Translation")
                          : request.purpose === "detect"
                            ? "Language detection"
                            : "Store profile"}
                      </s-text>
                      {request.resourceLabel ? (
                        <s-text color="subdued">{request.resourceLabel}</s-text>
                      ) : null}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <s-text color="subdued" fontVariantNumeric="tabular-nums">
                      {formatListDateTime(request.at)}
                    </s-text>
                  </s-table-cell>
                  <s-table-cell>
                    <s-text>{request.targetLocale}</s-text>
                  </s-table-cell>
                  <s-table-cell>
                    <s-text>{request.model}</s-text>
                  </s-table-cell>
                  <s-table-cell>
                    <Num>{formatTokens(request.inputTokens)}</Num>
                  </s-table-cell>
                  <s-table-cell>
                    <Num>{formatTokens(request.cachedInputTokens)}</Num>
                  </s-table-cell>
                  <s-table-cell>
                    <Num>{formatTokens(request.outputTokens)}</Num>
                  </s-table-cell>
                  <s-table-cell>
                    <Num>{formatCostExact(request.costMicros)}</Num>
                  </s-table-cell>
                  <s-table-cell>
                    {request.result === "ok" ? (
                      <s-text color="subdued">OK</s-text>
                    ) : (
                      <s-stack direction="block" gap="none">
                        <s-badge tone="critical">Failed</s-badge>
                        {request.errorMessage ? (
                          <s-text color="subdued">
                            {request.errorMessage}
                          </s-text>
                        ) : null}
                      </s-stack>
                    )}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
          {total > shown ? (
            <s-text color="subdued">
              {`The last ${formatRequests(shown)} of ${formatRequests(total)} requests.`}
            </s-text>
          ) : null}
        </s-stack>
      )}
    </s-section>
  );
}

function Fact({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail?: string | null;
  tone?: "warning";
}) {
  return (
    <s-stack direction="block" gap="small-500">
      <s-text color="subdued">{label}</s-text>
      <s-text type="strong" fontVariantNumeric="tabular-nums">
        {value}
      </s-text>
      {detail ? (
        <s-text color={tone ? "base" : "subdued"} {...(tone ? { tone } : {})}>
          {detail}
        </s-text>
      ) : null}
    </s-stack>
  );
}

/** The dialog's shape while the read is in flight, so it opens at its size. */
function Skeleton() {
  return (
    <s-stack
      direction="block"
      gap="base"
      accessibilityLabel="Loading the sync's usage"
    >
      <s-grid gridTemplateColumns="1fr 1fr 1fr 1fr" gap="base">
        {Array.from({ length: 8 }, (_, index) => (
          <s-stack key={index} direction="block" gap="small-400">
            <s-box
              background="subdued"
              borderRadius="base"
              minBlockSize="12px"
              inlineSize="40%"
            />
            <s-box
              background="subdued"
              borderRadius="base"
              minBlockSize="16px"
              inlineSize="70%"
            />
          </s-stack>
        ))}
      </s-grid>
      <s-divider />
      <s-box
        background="subdued"
        borderRadius="base"
        minBlockSize="180px"
        inlineSize="100%"
      />
      <s-box
        background="subdued"
        borderRadius="base"
        minBlockSize="220px"
        inlineSize="100%"
      />
      <s-stack direction="inline" justifyContent="center">
        <s-spinner accessibilityLabel="Loading" />
      </s-stack>
    </s-stack>
  );
}
