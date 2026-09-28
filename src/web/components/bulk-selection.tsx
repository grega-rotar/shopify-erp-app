import { useEffect, useState } from "react";

/**
 * Ticking rows of a table and acting on the ticked ones: the selection a
 * page keeps, and the bar that shows while anything is ticked.
 */

/**
 * Which rows of the page are ticked. When the rows change, a tick stays on
 * a row that is still there and goes with a row that left: a page that
 * re-reads itself live must not drop what someone is choosing, and a new
 * page of rows starts unticked because none of its rows were ticked.
 */
export function useSelection(ids: readonly string[]) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const key = ids.join(",");
  useEffect(() => {
    const present = new Set(ids);
    setSelected((current) => {
      const kept = [...current].filter((id) => present.has(id));
      return kept.length === current.size ? current : new Set(kept);
    });
  }, [key]);
  const all = ids.length > 0 && ids.every((id) => selected.has(id));
  return {
    selected,
    all,
    toggle: (id: string, on: boolean) =>
      setSelected((current) => {
        const next = new Set(current);
        if (on) next.add(id);
        else next.delete(id);
        return next;
      }),
    toggleAll: (on: boolean) => setSelected(on ? new Set(ids) : new Set()),
    clear: () => setSelected(new Set()),
  };
}

export interface BulkAction {
  label: string;
  onAct: () => void;
  /** Critical for what removes or forgets; neutral otherwise. */
  tone?: "critical" | "neutral";
  primary?: boolean;
}

export function BulkBar({
  count,
  noun,
  actions,
  busy,
  onClear,
}: {
  count: number;
  noun: string;
  actions: readonly BulkAction[];
  busy: boolean;
  onClear: () => void;
}) {
  if (count === 0) return null;
  return (
    <s-stack direction="inline" gap="base" alignItems="center">
      <s-text type="strong">{`${count.toLocaleString("en")} ${noun} selected`}</s-text>
      {actions.map((action) => (
        <s-button
          key={action.label}
          variant={action.primary ? "primary" : "secondary"}
          {...(action.tone === "critical" ? { tone: "critical" as const } : {})}
          onClick={action.onAct}
          {...(busy ? { disabled: true } : {})}
        >
          {action.label}
        </s-button>
      ))}
      <s-button variant="tertiary" onClick={onClear}>
        Clear
      </s-button>
    </s-stack>
  );
}
