import { useId } from "react";

import { SYNC_MODE_LABEL, type SyncMode } from "~/domain/translations/types";
import { type SyncSortKey } from "~/domain/translations/usage";
import { Dropdown, type DropdownOption } from "~/web/components/dropdown";
import { LocaleFlag } from "~/web/components/locale-flag";
import {
  Num,
  ShareCell,
  SortHeader,
} from "~/web/components/usage-breakdown-table";
import { formatDateTime } from "~/web/lib/datetime";
import { SYNC_MODES, type ShareBasis, type SyncRowView } from "~/web/lib/usage";
import {
  formatCost,
  formatRequests,
  formatTokens,
} from "~/web/lib/usage-format";
import { SYNC_STATUS_LABEL } from "~/web/lib/translations";

/**
 * Every sync the period's requests belong to, one row each, sorted and
 * paged by the server (docs/translations.md § AI usage): what it was, when
 * it started, into which languages, in which mode, and what it took. Each
 * fact is its own column so the table can be read down as well as across;
 * the row opens the sync's usage in a dialog.
 *
 * Filters and sort live in the address, the way the orders index does it,
 * so a filtered page can be reloaded or shared and the server pages the
 * filtered set rather than the browser paging a whole one.
 */
const COLUMNS: ReadonlyArray<{ key: SyncSortKey; label: string }> = [
  { key: "resources", label: "Resources" },
  { key: "tokens", label: "Tokens" },
  { key: "requests", label: "Requests" },
  { key: "cost", label: "Cost" },
];

export interface SyncTableState {
  sort: SyncSortKey;
  desc: boolean;
  page: number;
  locale: string | null;
  mode: string | null;
}

export function UsageSyncTable({
  rows,
  total,
  pageSize,
  state,
  languages,
  shareBasis,
  loading,
  onChange,
  onOpen,
}: {
  rows: SyncRowView[];
  /** Syncs across every page of the filtered set. */
  total: number;
  pageSize: number;
  state: SyncTableState;
  /** The languages the period's requests went into, for the filter. */
  languages: ReadonlyArray<{ locale: string; name: string }>;
  shareBasis: ShareBasis;
  loading: boolean;
  onChange: (patch: Partial<SyncTableState>) => void;
  onOpen: (row: SyncRowView) => void;
}) {
  const tipId = `usage-sync-share-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const filtered = state.locale !== null || state.mode !== null;
  const peakShare = Math.max(0, ...rows.map((row) => row.share ?? 0));

  const languageOptions: DropdownOption[] = [
    { value: "", label: "All languages" },
    ...languages.map((language) => ({
      value: language.locale,
      label: `${language.name} (${language.locale})`,
    })),
  ];
  const modeOptions: DropdownOption[] = [
    { value: "", label: "All modes" },
    ...SYNC_MODES.map((mode) => ({
      value: mode,
      label: SYNC_MODE_LABEL[mode],
    })),
  ];

  const sortBy = (key: SyncSortKey) =>
    onChange({
      sort: key,
      desc: state.sort === key ? !state.desc : true,
      page: 1,
    });

  return (
    <s-section heading="Usage by sync">
      <s-stack direction="block" gap="small-300">
        <s-table
          variant="auto"
          {...(loading ? { loading: true } : {})}
          {...(pages > 1 ? { paginate: true } : {})}
          {...(state.page < pages ? { hasNextPage: true } : {})}
          {...(state.page > 1 ? { hasPreviousPage: true } : {})}
          onNextPage={() => onChange({ page: state.page + 1 })}
          onPreviousPage={() => onChange({ page: Math.max(1, state.page - 1) })}
        >
          <s-grid
            slot="filters"
            gridTemplateColumns="@container (inline-size <= 560px) 1fr, 'minmax(180px, 240px) minmax(180px, 240px) auto 1fr'"
            gap="small-300"
            alignItems="center"
          >
            <Dropdown
              name="locale"
              label="Language"
              hideLabel
              value={state.locale ?? ""}
              options={languageOptions}
              onChange={(value) => onChange({ locale: value || null, page: 1 })}
            />
            <Dropdown
              name="mode"
              label="Mode"
              hideLabel
              value={state.mode ?? ""}
              options={modeOptions}
              onChange={(value) => onChange({ mode: value || null, page: 1 })}
            />
            {filtered ? (
              <s-button
                variant="tertiary"
                onClick={() => onChange({ locale: null, mode: null, page: 1 })}
              >
                Clear filters
              </s-button>
            ) : (
              <s-box />
            )}
            <s-box>
              <s-stack direction="inline" justifyContent="end">
                <s-text color="subdued" fontVariantNumeric="tabular-nums">
                  {total === 1
                    ? "1 sync"
                    : `${formatRequests(total)} syncs${pages > 1 ? ` · page ${state.page} of ${pages}` : ""}`}
                </s-text>
              </s-stack>
            </s-box>
          </s-grid>

          <s-table-header-row>
            <s-table-header listSlot="primary">Sync</s-table-header>
            <s-table-header listSlot="kicker">
              <SortHeader
                label="Started"
                active={state.sort === "started"}
                desc={state.desc}
                align="start"
                onClick={() => sortBy("started")}
              />
            </s-table-header>
            <s-table-header listSlot="inline">Languages</s-table-header>
            <s-table-header listSlot="inline">Mode</s-table-header>
            {COLUMNS.map((col) => (
              <s-table-header
                key={col.key}
                format="numeric"
                {...(col.key === "cost"
                  ? { listSlot: "secondary" as const }
                  : {})}
              >
                <SortHeader
                  label={col.label}
                  active={state.sort === col.key}
                  desc={state.desc}
                  onClick={() => sortBy(col.key)}
                />
              </s-table-header>
            ))}
            <s-table-header format="numeric">
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
            </s-table-header>
          </s-table-header-row>

          <s-table-body>
            {rows.map((row) => {
              const rowId = `open-sync-${row.id ?? "none"}`;
              return (
                <s-table-row key={row.id ?? "none"} clickDelegate={rowId}>
                  <s-table-cell>
                    <s-stack
                      direction="inline"
                      gap="small-300"
                      alignItems="center"
                    >
                      <s-link id={rowId} onClick={() => onOpen(row)}>
                        {row.name}
                      </s-link>
                      {row.status && row.status !== "completed" ? (
                        <s-badge
                          {...(row.status === "failed"
                            ? { tone: "critical" as const }
                            : row.status === "running" ||
                                row.status === "queued"
                              ? { tone: "info" as const }
                              : {})}
                        >
                          {SYNC_STATUS_LABEL[row.status] ?? row.status}
                        </s-badge>
                      ) : null}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <s-text color="subdued" fontVariantNumeric="tabular-nums">
                      {formatDateTime(row.startedAt)}
                    </s-text>
                  </s-table-cell>
                  <s-table-cell>
                    <Languages languages={row.languages} />
                  </s-table-cell>
                  <s-table-cell>
                    <s-text>
                      {row.mode
                        ? (SYNC_MODE_LABEL[row.mode as SyncMode] ?? row.mode)
                        : "—"}
                    </s-text>
                  </s-table-cell>
                  <s-table-cell>
                    <Num>{formatRequests(row.resources)}</Num>
                  </s-table-cell>
                  <s-table-cell>
                    <Num>{formatTokens(row.totalTokens)}</Num>
                  </s-table-cell>
                  <s-table-cell>
                    <Num>{formatRequests(row.requests)}</Num>
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="block" gap="none" alignItems="end">
                      <Num>{formatCost(row.costMicros)}</Num>
                      {row.unpriced > 0 ? (
                        <s-text color="subdued">
                          {`${formatRequests(row.unpriced)} not priced`}
                        </s-text>
                      ) : null}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <ShareCell share={row.share} peak={peakShare} />
                  </s-table-cell>
                </s-table-row>
              );
            })}
          </s-table-body>
        </s-table>

        {rows.length === 0 && !loading ? (
          <s-box paddingBlock="large-100">
            <s-stack direction="block" gap="base" alignItems="center">
              <s-text color="subdued">
                {filtered
                  ? "No syncs match these filters in this period."
                  : "No syncs in this period."}
              </s-text>
              {filtered ? (
                <s-button
                  variant="secondary"
                  onClick={() =>
                    onChange({ locale: null, mode: null, page: 1 })
                  }
                >
                  Clear filters
                </s-button>
              ) : null}
            </s-stack>
          </s-box>
        ) : null}
      </s-stack>
    </s-section>
  );
}

/** The languages a sync translated into: flags with names, a count past three. */
function Languages({ languages }: { languages: SyncRowView["languages"] }) {
  if (languages.length === 0) return <s-text color="subdued">—</s-text>;
  const shown = languages.slice(0, 3);
  const more = languages.length - shown.length;
  return (
    <s-stack direction="inline" gap="small-300" alignItems="center">
      {shown.map((language) => (
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
      {more > 0 ? <s-text color="subdued">{`+${more}`}</s-text> : null}
    </s-stack>
  );
}
