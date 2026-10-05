import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";

import type { TrendBucket } from "~/domain/translations/usage";
import type { TrendPointView } from "~/web/lib/usage";
import {
  formatBucketLabel,
  formatBucketTitle,
  formatCost,
  formatRequests,
  formatTokens,
} from "~/web/lib/usage-format";

/**
 * Usage over time (docs/translations.md § AI usage): one bar per hour, day
 * or month, as cost, tokens or requests, with a real axis and a tooltip
 * that says what the bar is.
 *
 * Inline SVG, because a charting library is a
 * second design system inside a Polaris page (docs/BUILD_SPEC.md section
 * 2.6). Colours are Polaris custom properties with the admin's greys as
 * fallbacks, so the chart follows the palette; nothing on it is coloured,
 * because colour marks exceptions and there are none here.
 *
 * The height is fixed so the card never reflows (section 2.5 budgets CLS);
 * the width follows the card, measured after hydration, so a bar a day is
 * a readable bar on a wide screen rather than a scaled thumbnail. Until it
 * is measured the chart is drawn at a nominal width and scaled, which is
 * one frame.
 *
 * Tokens stack three ways — input the provider read in full, input it
 * served from its cache at the lower rate, and output — because the cache
 * is the difference between two syncs of the same size costing the same or
 * not, and that is the question this chart is for.
 *
 * The tooltip is drawn inside the SVG so it needs no positioning of its own;
 * the pointer and the arrow keys move it, so the figures are reachable
 * without a mouse, and the whole chart is labelled for a screen reader.
 */
export type UsageMetric = "cost" | "tokens" | "requests";

const HEIGHT = 300;
const PAD = { top: 16, right: 12, bottom: 28, left: 56 };
const NOMINAL_WIDTH = 960;
const GRID_LINES = 4;

const INK = "var(--s-color-text, #303030)";
const INK_SUBDUED = "var(--s-color-text-subdued, #616161)";
const RULE = "var(--s-color-border, #e3e3e3)";
const CACHED = "var(--s-color-border, #c9cccf)";
const SURFACE = "var(--s-color-bg-surface, #ffffff)";
const BAND = "rgba(0, 0, 0, 0.05)";

const METRICS: ReadonlyArray<{ key: UsageMetric; label: string }> = [
  { key: "cost", label: "Cost" },
  { key: "tokens", label: "Tokens" },
  { key: "requests", label: "Requests" },
];

/** A round ceiling above the peak, so the top gridline carries a round label. */
function niceCeiling(peak: number): number {
  if (peak <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(peak));
  const normalised = peak / magnitude;
  const step =
    [1, 2, 2.5, 4, 5, 10].find((candidate) => normalised <= candidate) ?? 10;
  return step * magnitude;
}

function axisLabel(metric: UsageMetric, value: number): string {
  if (metric === "cost") {
    const dollars = value / 1_000_000;
    if (dollars === 0) return "$0";
    if (dollars < 0.01) return `$${dollars.toFixed(3)}`;
    if (dollars < 1) return `$${dollars.toFixed(2)}`;
    return `$${Number.isInteger(dollars) ? dollars : dollars.toFixed(2)}`;
  }
  return formatTokens(value);
}

function metricValue(point: TrendPointView, metric: UsageMetric): number {
  if (metric === "cost") return point.costMicros;
  if (metric === "tokens") return point.totalTokens;
  return point.requests;
}

export function UsageChart({
  points,
  bucket,
  priced,
}: {
  points: TrendPointView[];
  bucket: TrendBucket;
  /** Whether anything in the period has a price; if not, cost is not offered. */
  priced: boolean;
}) {
  const [metric, setMetric] = useState<UsageMetric>(priced ? "cost" : "tokens");
  const [hover, setHover] = useState<number | null>(null);
  const [width, setWidth] = useState(NOMINAL_WIDTH);
  const frame = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = frame.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width;
      if (measured && measured > 0) setWidth(Math.round(measured));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!priced && metric === "cost") setMetric("tokens");
  }, [priced, metric]);

  const plotWidth = Math.max(80, width - PAD.left - PAD.right);
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const slot = points.length > 0 ? plotWidth / points.length : plotWidth;
  const barWidth = Math.max(2, Math.min(40, slot * 0.68));

  const peak = useMemo(
    () => Math.max(0, ...points.map((point) => metricValue(point, metric))),
    [points, metric],
  );
  const ceiling = niceCeiling(peak);
  const scale = (value: number) => (value / ceiling) * plotHeight;
  const baseline = PAD.top + plotHeight;

  const labelEvery = Math.max(1, Math.ceil((points.length * 72) / plotWidth));
  const total = points.reduce((sum, point) => sum + point.requests, 0);
  const anything = points.some((point) => point.requests > 0);

  const indexAt = (event: MouseEvent<SVGSVGElement>): number | null => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * width - PAD.left;
    if (!Number.isFinite(x) || x < 0 || x > plotWidth || points.length === 0)
      return null;
    return Math.min(points.length - 1, Math.floor(x / slot));
  };

  const onKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    if (points.length === 0) return;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const step = event.key === "ArrowRight" ? 1 : -1;
      setHover((now) => {
        const from = now ?? (step > 0 ? -1 : points.length);
        return Math.max(0, Math.min(points.length - 1, from + step));
      });
    } else if (event.key === "Home") {
      event.preventDefault();
      setHover(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setHover(points.length - 1);
    } else if (event.key === "Escape") {
      setHover(null);
    }
  };

  const hovered = hover !== null ? (points[hover] ?? null) : null;
  const summary = `${METRICS.find((m) => m.key === metric)?.label ?? "Usage"} per ${bucket} over ${points.length} ${bucket}s; ${formatRequests(total)} requests in total. Use the arrow keys to read each ${bucket}.`;

  return (
    <s-stack direction="block" gap="small-300">
      <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
        <s-text color="subdued">
          {metric === "tokens"
            ? `Tokens per ${bucket}: input, cached input and output.`
            : metric === "cost"
              ? `Estimated cost per ${bucket}.`
              : `Requests per ${bucket}.`}
        </s-text>
        {/*
         * A stack, not `s-button-group`: the group only draws its buttons
         * when it is slotted into a page header; anywhere else its children
         * have no box at all.
         */}
        <s-stack
          direction="inline"
          gap="small-300"
          alignItems="center"
          accessibilityLabel="Chart metric"
        >
          {METRICS.map((option) => (
            <s-button
              key={option.key}
              variant={option.key === metric ? "secondary" : "tertiary"}
              {...(option.key === "cost" && !priced ? { disabled: true } : {})}
              onClick={() => setMetric(option.key)}
            >
              {option.label}
            </s-button>
          ))}
        </s-stack>
      </s-grid>

      <div ref={frame} style={{ width: "100%", height: HEIGHT }}>
        {anything ? (
          <svg
            viewBox={`0 0 ${width} ${HEIGHT}`}
            width="100%"
            height={HEIGHT}
            role="img"
            aria-label={summary}
            tabIndex={0}
            style={{ display: "block", outlineOffset: "2px" }}
            onMouseMove={(event) => setHover(indexAt(event))}
            onMouseLeave={() => setHover(null)}
            onBlur={() => setHover(null)}
            onKeyDown={onKeyDown}
          >
            {/* Gridlines and their labels, the top one at the round ceiling. */}
            {Array.from({ length: GRID_LINES + 1 }, (_, line) => {
              const value = (ceiling / GRID_LINES) * line;
              const y = baseline - scale(value) + 0.5;
              return (
                <g key={line}>
                  <line
                    x1={PAD.left}
                    x2={width - PAD.right}
                    y1={y}
                    y2={y}
                    stroke={RULE}
                    strokeDasharray={line === 0 ? undefined : "2 3"}
                  />
                  <text
                    x={PAD.left - 8}
                    y={y + 4}
                    textAnchor="end"
                    fontSize="11"
                    fill={INK_SUBDUED}
                  >
                    {axisLabel(metric, value)}
                  </text>
                </g>
              );
            })}

            {points.map((point, index) => {
              const x = PAD.left + slot * index + (slot - barWidth) / 2;
              const isHovered = hover === index;
              const segments =
                metric === "tokens"
                  ? [
                      {
                        value: Math.max(
                          0,
                          point.inputTokens - point.cachedInputTokens,
                        ),
                        fill: INK,
                      },
                      { value: point.cachedInputTokens, fill: CACHED },
                      { value: point.outputTokens, fill: INK_SUBDUED },
                    ]
                  : [{ value: metricValue(point, metric), fill: INK }];
              let top = baseline;
              return (
                <g key={point.at}>
                  {isHovered ? (
                    <rect
                      x={PAD.left + slot * index}
                      y={PAD.top}
                      width={slot}
                      height={plotHeight}
                      fill={BAND}
                    />
                  ) : null}
                  {segments.map((segment, part) => {
                    if (segment.value <= 0) return null;
                    const height = Math.max(1, scale(segment.value));
                    top -= height;
                    return (
                      <rect
                        key={part}
                        x={x}
                        y={top}
                        width={barWidth}
                        height={height}
                        fill={segment.fill}
                        opacity={hover === null || isHovered ? 1 : 0.55}
                      />
                    );
                  })}
                  {index % labelEvery === 0 ? (
                    <text
                      x={x + barWidth / 2}
                      y={HEIGHT - 8}
                      textAnchor="middle"
                      fontSize="11"
                      fill={INK_SUBDUED}
                    >
                      {formatBucketLabel(point.at, bucket)}
                    </text>
                  ) : null}
                </g>
              );
            })}

            {hovered && hover !== null ? (
              <Tooltip
                point={hovered}
                bucket={bucket}
                metric={metric}
                anchorX={PAD.left + slot * hover + slot / 2}
                width={width}
              />
            ) : null}
          </svg>
        ) : (
          <s-box padding="large" blockSize="100%">
            <s-stack
              direction="block"
              gap="small-300"
              alignItems="center"
              justifyContent="center"
              blockSize="100%"
            >
              <s-text color="subdued">
                No requests reached the provider in this period.
              </s-text>
            </s-stack>
          </s-box>
        )}
      </div>

      {metric === "tokens" && anything ? (
        <s-stack direction="inline" gap="base" alignItems="center">
          <Swatch fill={INK} label="Input" />
          <Swatch fill={CACHED} label="Cached input" />
          <Swatch fill={INK_SUBDUED} label="Output" />
        </s-stack>
      ) : null}
    </s-stack>
  );
}

const TIP_WIDTH = 200;
const TIP_LINE = 16;

/** The hovered bucket's figures, drawn beside its bar and kept on the chart. */
function Tooltip({
  point,
  bucket,
  metric,
  anchorX,
  width,
}: {
  point: TrendPointView;
  bucket: TrendBucket;
  metric: UsageMetric;
  anchorX: number;
  width: number;
}) {
  const lines: Array<{ label: string; value: string; muted?: boolean }> = [
    { label: "Estimated cost", value: formatCost(point.costMicros) },
    { label: "Tokens", value: formatTokens(point.totalTokens) },
  ];
  if (metric === "tokens") {
    lines.push(
      {
        label: "Input",
        value: formatTokens(
          Math.max(0, point.inputTokens - point.cachedInputTokens),
        ),
        muted: true,
      },
      {
        label: "Cached input",
        value: formatTokens(point.cachedInputTokens),
        muted: true,
      },
      { label: "Output", value: formatTokens(point.outputTokens), muted: true },
    );
  }
  lines.push({ label: "Requests", value: formatRequests(point.requests) });

  const height = 12 + TIP_LINE * (lines.length + 1) + 8;
  const flip = anchorX + 14 + TIP_WIDTH > width - PAD.right;
  const x = flip ? anchorX - 14 - TIP_WIDTH : anchorX + 14;
  const y = PAD.top;

  return (
    <g pointerEvents="none">
      <rect
        x={x}
        y={y}
        width={TIP_WIDTH}
        height={height}
        rx="6"
        fill={SURFACE}
        stroke={RULE}
      />
      <text
        x={x + 12}
        y={y + 12 + TIP_LINE - 4}
        fontSize="12"
        fontWeight="600"
        fill={INK}
      >
        {formatBucketTitle(point.at, bucket)}
      </text>
      {lines.map((line, index) => {
        const lineY = y + 12 + TIP_LINE * (index + 2) - 4;
        return (
          <g key={line.label}>
            <text
              x={x + 12 + (line.muted ? 10 : 0)}
              y={lineY}
              fontSize="12"
              fill={INK_SUBDUED}
            >
              {line.label}
            </text>
            <text
              x={x + TIP_WIDTH - 12}
              y={lineY}
              fontSize="12"
              textAnchor="end"
              fill={line.muted ? INK_SUBDUED : INK}
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {line.value}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function Swatch({ fill, label }: { fill: string; label: string }) {
  return (
    <s-stack direction="inline" gap="small-400" alignItems="center">
      <svg
        width="12"
        height="12"
        viewBox="0 0 12 12"
        aria-hidden="true"
        style={{ display: "block" }}
      >
        <rect width="12" height="12" rx="2" fill={fill} />
      </svg>
      <s-text color="subdued">{label}</s-text>
    </s-stack>
  );
}
