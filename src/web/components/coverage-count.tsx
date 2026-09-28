import type { CoverageProgress } from "~/adapters/translations/syncs.server";
import { formatDateTime } from "~/web/lib/datetime";

/**
 * Where the store-wide coverage count stands (docs/translations.md
 * § Coverage), with the button that starts one. While it runs: how far, as
 * a bar, and what it is reading, so a large store's count is visibly moving
 * rather than a word that never changes. A count that stopped says so and
 * can be started again; content Shopify would not read is named.
 *
 * `compact` drops the sentence about when counts happen, for a sidebar.
 */
export function CoverageCount({
  progress,
  countedAt,
  busy,
  onCount,
  compact = false,
}: {
  progress: CoverageProgress;
  countedAt: string | null;
  busy: boolean;
  onCount: () => void;
  compact?: boolean;
}) {
  const counting = progress.state === "counting";
  const button = (
    <s-button
      type="button"
      variant={compact ? "tertiary" : "secondary"}
      onClick={onCount}
      {...(busy || counting ? { disabled: true } : {})}
      {...(counting ? { loading: true } : {})}
    >
      {counting ? "Counting" : countedAt ? "Count again" : "Count coverage"}
    </s-button>
  );

  if (counting) {
    const read = progress.resourcesRead.toLocaleString("en");
    const of = progress.expectedResources
      ? ` of about ${progress.expectedResources.toLocaleString("en")}`
      : "";
    return (
      <s-stack direction="block" gap="small-300">
        <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
          <s-text type="strong">{`Counting translations · ${progress.percent ?? 0}%`}</s-text>
          {compact ? null : button}
        </s-grid>
        <ProgressBar percent={progress.percent ?? 0} />
        <s-text color="subdued">
          {`${progress.reading ? `Reading ${progress.reading.toLowerCase()}s. ` : ""}${read}${of} resources read, ${progress.typesDone} of ${progress.typesTotal} kinds of content done.`}
        </s-text>
        {compact ? null : (
          <s-text color="subdued">
            The table fills in as each kind of content is counted. You can leave
            this page; the count carries on.
          </s-text>
        )}
      </s-stack>
    );
  }

  return (
    <s-stack direction="block" gap="small-300">
      {progress.state === "stalled" ? (
        <s-banner tone="warning" heading="The count stopped">
          <s-paragraph>{progress.message}</s-paragraph>
        </s-banner>
      ) : null}
      {progress.state === "problem" ? (
        <s-banner tone="warning" heading="Some content could not be counted">
          <s-paragraph>{progress.message}</s-paragraph>
        </s-banner>
      ) : null}
      <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
        <s-text color="subdued">
          {countedAt
            ? compact
              ? `Counted ${formatDateTime(countedAt)}.`
              : `Coverage counted ${formatDateTime(countedAt)} across every translatable field. It is recounted after each sync you start and nightly.`
            : "Coverage has not been counted yet. Count it once to see what each language is missing."}
        </s-text>
        {button}
      </s-grid>
    </s-stack>
  );
}

function ProgressBar({ percent }: { percent: number }) {
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-label="Coverage count progress"
      style={{
        height: 8,
        borderRadius: 4,
        overflow: "hidden",
        background: "var(--s-color-border, #e3e3e3)",
      }}
    >
      <div
        style={{
          width: `${Math.max(2, percent)}%`,
          height: "100%",
          borderRadius: 4,
          background: "var(--s-color-bg-fill-info, #0094d5)",
          transition: "width 600ms ease",
        }}
      />
    </div>
  );
}
