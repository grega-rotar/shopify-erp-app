import type { OperationTile } from "~/web/lib/home";

/**
 * Six short summaries, one per part of the store this app runs: what it is
 * doing and when it last did it, two or three lines each, and the whole
 * summary a link to the page that owns it.
 *
 * Healthy is calm (docs/ui-conventions.md § Setup state): no badges, no
 * green, and only a line that states a problem carries a tone. Problems are
 * counted in Needs attention, not here.
 *
 * Three across on a wide admin, two on a laptop, one on a phone, measured
 * against the section rather than the window — the query container is what
 * the breakpoints read (docs/ui-conventions.md § Polaris web components).
 */
export function StoreOperations({ tiles }: { tiles: OperationTile[] }) {
  return (
    <s-section heading="Store operations">
      <s-query-container>
        <s-grid
          gridTemplateColumns="@container (inline-size <= 520px) 1fr, (inline-size <= 820px) 'minmax(0, 1fr) minmax(0, 1fr)', 'minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)'"
          gap="base"
        >
          {tiles.map((tile) => (
            <Tile key={tile.key} tile={tile} />
          ))}
        </s-grid>
      </s-query-container>
    </s-section>
  );
}

function Tile({ tile }: { tile: OperationTile }) {
  const [state, ...rest] = tile.lines;
  return (
    <s-clickable
      href={tile.href}
      border="base"
      borderRadius="base"
      padding="base"
      blockSize="100%"
      accessibilityLabel={`${tile.title}: ${tile.lines.map((line) => line.text).join(". ")}`}
    >
      <s-stack direction="block" gap="small-300">
        <s-grid
          gridTemplateColumns="1fr auto"
          gap="small-300"
          alignItems="center"
        >
          <s-text type="strong">{tile.title}</s-text>
          <s-icon type="chevron-right" color="subdued" size="small" />
        </s-grid>
        <s-stack direction="block" gap="small-500">
          {state ? <Line line={state} primary /> : null}
          {rest.map((line) => (
            <Line key={line.text} line={line} />
          ))}
        </s-stack>
      </s-stack>
    </s-clickable>
  );
}

function Line({
  line,
  primary = false,
}: {
  line: OperationTile["lines"][number];
  primary?: boolean;
}) {
  if (line.tone) {
    return <s-text tone={line.tone}>{line.text}</s-text>;
  }
  return primary ? (
    <s-text>{line.text}</s-text>
  ) : (
    <s-text color="subdued">{line.text}</s-text>
  );
}
