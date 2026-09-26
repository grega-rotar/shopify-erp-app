import { useId, useRef, useState } from "react";

import {
  USAGE_PERIODS,
  USAGE_PERIOD_LABEL,
  type UsagePeriod,
} from "~/domain/translations/usage";

/**
 * The period the usage page reports on, chosen from a button that names the
 * current one: the presets as a list, and a custom span as two dates under
 * them (docs/translations.md § AI usage).
 *
 * Built from `s-button` and `s-popover` the way `Dropdown` is, so the open
 * list is drawn by Polaris rather than the operating system. The custom
 * dates apply from their own button rather than on every keystroke, since
 * half a date is not a period.
 */
type Overlay = { hideOverlay?: () => void };

const PRESETS = USAGE_PERIODS.filter((period) => period !== "custom");

export function UsageRangePicker({
  period,
  label,
  from,
  to,
  loading,
  onSelect,
}: {
  period: UsagePeriod;
  /** What the button says: the preset's name, or the custom span. */
  label: string;
  /** The custom dates, `YYYY-MM-DD`, when the period is custom. */
  from: string | null;
  to: string | null;
  loading: boolean;
  onSelect: (
    period: UsagePeriod,
    custom?: { from: string; to: string },
  ) => void;
}) {
  const popoverId = `usage-range-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const overlay = useRef<Overlay | null>(null);
  const [customOpen, setCustomOpen] = useState(period === "custom");
  const [draftFrom, setDraftFrom] = useState(from ?? "");
  const [draftTo, setDraftTo] = useState(to ?? "");

  const draftValid =
    /^\d{4}-\d{2}-\d{2}$/.test(draftFrom) &&
    /^\d{4}-\d{2}-\d{2}$/.test(draftTo) &&
    draftFrom <= draftTo;

  return (
    <>
      <s-button
        variant="secondary"
        icon="calendar"
        commandFor={popoverId}
        accessibilityLabel={`Reporting period: ${label}`}
        {...(loading ? { loading: true } : {})}
      >
        {label}
      </s-button>

      <s-popover
        id={popoverId}
        minInlineSize="280px"
        ref={(element) => {
          overlay.current = (element as Overlay | null) ?? null;
        }}
        onAfterHide={() => {
          setCustomOpen(period === "custom");
          setDraftFrom(from ?? "");
          setDraftTo(to ?? "");
        }}
      >
        <s-stack direction="block" gap="none">
          {PRESETS.map((preset) => (
            <s-clickable
              key={preset}
              command="--hide"
              commandFor={popoverId}
              borderRadius="base"
              paddingInline="small-200"
              paddingBlock="small-300"
              inlineSize="100%"
              onClick={() => onSelect(preset)}
            >
              <s-grid
                gridTemplateColumns="1fr auto"
                gap="small-200"
                alignItems="center"
              >
                <s-text>{USAGE_PERIOD_LABEL[preset]}</s-text>
                {preset === period ? (
                  <s-icon type="check" />
                ) : (
                  <s-box inlineSize="20px" />
                )}
              </s-grid>
            </s-clickable>
          ))}

          <s-clickable
            borderRadius="base"
            paddingInline="small-200"
            paddingBlock="small-300"
            inlineSize="100%"
            onClick={() => setCustomOpen((open) => !open)}
          >
            <s-grid
              gridTemplateColumns="1fr auto"
              gap="small-200"
              alignItems="center"
            >
              <s-text>{USAGE_PERIOD_LABEL.custom}</s-text>
              {period === "custom" ? (
                <s-icon type="check" />
              ) : (
                <s-icon type={customOpen ? "chevron-up" : "chevron-down"} />
              )}
            </s-grid>
          </s-clickable>

          {customOpen ? (
            <s-box padding="small-200" paddingBlockStart="small-300">
              <s-stack direction="block" gap="small-300">
                <s-date-field
                  label="From"
                  value={draftFrom}
                  onChange={(event) => setDraftFrom(event.currentTarget.value)}
                />
                <s-date-field
                  label="To"
                  value={draftTo}
                  onChange={(event) => setDraftTo(event.currentTarget.value)}
                  {...(draftFrom && draftTo && draftFrom > draftTo
                    ? { error: "The end is before the start." }
                    : {})}
                />
                <s-button
                  variant="primary"
                  {...(draftValid ? {} : { disabled: true })}
                  onClick={() => {
                    if (!draftValid) return;
                    overlay.current?.hideOverlay?.();
                    onSelect("custom", { from: draftFrom, to: draftTo });
                  }}
                >
                  Apply
                </s-button>
              </s-stack>
            </s-box>
          ) : null}
        </s-stack>
      </s-popover>
    </>
  );
}
