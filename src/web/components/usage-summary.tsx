import { useId, type ReactNode } from "react";

import { formatShare, sharePercent } from "~/domain/translations/usage";
import type { UsageTotalsView } from "~/web/lib/usage";
import {
  formatCost,
  formatRequests,
  formatTokens,
} from "~/web/lib/usage-format";

/**
 * The period at a glance: five figures in one strip, each with the
 * one secondary fact that explains it (docs/translations.md § AI usage).
 * One card rather than five, because the figures are one reading — what
 * was sent, what came back, what it cost — not five unrelated cards.
 *
 * The figure itself is set two steps larger than body text. Polaris draws
 * every heading at one size, and a summary whose numbers are the same size
 * as their captions is not a summary; this is the one place the page sets
 * its own type size, and it is a size on a number, never a colour.
 */
export function UsageSummary({
  totals,
  pricingVersion,
  loading,
}: {
  totals: UsageTotalsView;
  pricingVersion: string;
  loading: boolean;
}) {
  const tipId = `usage-cost-tip-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const cached = sharePercent(totals.cachedInputTokens, totals.inputTokens);
  const outputShare = sharePercent(totals.outputTokens, totals.totalTokens);
  const perResource =
    totals.resources > 0
      ? Math.round(totals.totalTokens / totals.resources)
      : null;

  return (
    <s-section padding="base" accessibilityLabel="Usage at a glance">
      <s-grid
        gridTemplateColumns="@container (inline-size <= 720px) 1fr 1fr, 1fr 1fr 1fr 1fr 1fr"
        gap="base"
        alignItems="start"
      >
        <Metric
          label="Estimated cost"
          tip={{
            id: tipId,
            text: `Estimated from the provider's list prices (pricing table ${pricingVersion}), which report tokens rather than money. Retries and failed requests that reported usage are included; cached input is priced at the provider's lower rate.`,
          }}
          value={formatCost(totals.costMicros)}
          detail={
            totals.unpriced > 0
              ? `${formatRequests(totals.unpriced)} requests not priced`
              : `${formatTokens(totals.totalTokens)} total tokens`
          }
          tone={totals.unpriced > 0 ? "warning" : undefined}
          loading={loading}
        />
        <Metric
          label="Input tokens"
          value={formatTokens(totals.inputTokens)}
          detail={
            totals.cachedInputTokens > 0
              ? `${formatTokens(totals.cachedInputTokens)} cached (${formatShare(cached)})`
              : "Nothing served from cache"
          }
          loading={loading}
        />
        <Metric
          label="Output tokens"
          value={formatTokens(totals.outputTokens)}
          detail={
            totals.totalTokens > 0
              ? `${formatShare(outputShare)} of all tokens`
              : null
          }
          loading={loading}
        />
        <Metric
          label="Requests"
          value={formatRequests(totals.requests)}
          detail={
            totals.failed > 0
              ? `${formatRequests(totals.failed)} failed`
              : totals.requests > 0
                ? "None failed"
                : null
          }
          tone={totals.failed > 0 ? "warning" : undefined}
          loading={loading}
        />
        <Metric
          label="Resources translated"
          value={formatRequests(totals.resources)}
          detail={
            perResource !== null
              ? `${formatTokens(perResource)} tokens each`
              : null
          }
          loading={loading}
        />
      </s-grid>
    </s-section>
  );
}

function Metric({
  label,
  tip,
  value,
  detail,
  tone,
  loading,
}: {
  label: string;
  tip?: { id: string; text: string };
  value: string;
  detail?: string | null;
  tone?: "warning";
  loading: boolean;
}) {
  return (
    <s-stack direction="block" gap="small-500">
      <s-stack direction="inline" gap="small-400" alignItems="center">
        <s-text color="subdued">{label}</s-text>
        {tip ? (
          <>
            <s-icon
              type="info"
              size="small"
              color="subdued"
              interestFor={tip.id}
            />
            <s-tooltip id={tip.id}>{tip.text}</s-tooltip>
          </>
        ) : null}
      </s-stack>
      <Figure dimmed={loading}>{value}</Figure>
      {/* Always a line, so the strip keeps its height while a figure has nothing to add. */}
      <s-text
        color={tone ? "base" : "subdued"}
        {...(tone ? { tone } : {})}
        fontVariantNumeric="tabular-nums"
      >
        {detail ?? " "}
      </s-text>
    </s-stack>
  );
}

/** The number, two steps up from body text; see the component's note. */
function Figure({
  children,
  dimmed,
}: {
  children: ReactNode;
  dimmed: boolean;
}) {
  return (
    <s-heading accessibilityRole="presentation">
      <span
        style={{
          display: "inline-block",
          fontSize: "20px",
          lineHeight: "24px",
          fontWeight: 650,
          fontVariantNumeric: "tabular-nums",
          opacity: dimmed ? 0.5 : 1,
        }}
      >
        {children}
      </span>
    </s-heading>
  );
}
