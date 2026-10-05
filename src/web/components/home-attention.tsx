import type { HomeAttention } from "~/web/lib/home";

/**
 * Home's Needs attention: one row per area, never one per record.
 *
 * A row names the area, says what is wrong in a sentence, carries the count
 * and one button to the records — the Needs attention page, filtered to the
 * area, which is where each record and its guidance lives. A setting that
 * stopped being true since setup comes first, because it is usually the
 * cause of the rows under it.
 *
 * The count is the loudest thing on the page (docs/ui-conventions.md
 * § Element semantics). An area with nothing open has no row, and with
 * nothing anywhere the section is not rendered at all.
 */
export function HomeAttentionSection({
  attention,
}: {
  attention: HomeAttention;
}) {
  const { setup, groups, total } = attention;

  return (
    <s-section accessibilityLabel="Needs attention">
      <s-stack direction="block" gap="small-200">
        <s-grid
          gridTemplateColumns="1fr auto"
          gap="small-300"
          alignItems="center"
        >
          <s-heading>Needs attention</s-heading>
          {total > 0 ? (
            <s-text color="subdued">{`${total.toLocaleString("en")} total`}</s-text>
          ) : null}
        </s-grid>

        <s-query-container>
          <s-stack direction="block">
            {setup.map((problem, index) => (
              <Row
                key={`setup-${problem.key}`}
                first={index === 0}
                label={problem.title}
                text={problem.text}
                count={null}
                action={problem.action}
              />
            ))}
            {groups.map((group, index) => (
              <Row
                key={group.area}
                first={setup.length === 0 && index === 0}
                label={group.label}
                text={group.text}
                count={group.count}
                action={{ label: group.cta, href: group.href }}
              />
            ))}
          </s-stack>
        </s-query-container>
      </s-stack>
    </s-section>
  );
}

function Row({
  first,
  label,
  text,
  count,
  action,
}: {
  first: boolean;
  label: string;
  text: string;
  /** Null for a setting, which is one problem rather than a number of them. */
  count: number | null;
  action: { label: string; href: string } | null;
}) {
  return (
    <s-stack direction="block">
      {first ? null : <s-divider />}
      <s-grid
        gridTemplateColumns="@container (inline-size <= 520px) 1fr auto, 1fr auto auto"
        gap="small-300 base"
        alignItems="center"
        paddingBlock="small-200"
      >
        <s-stack direction="block" gap="small-500">
          <s-text type="strong">{label}</s-text>
          <s-text color="subdued">{text}</s-text>
        </s-stack>
        {count === null ? (
          // Keeps the button in its column; a setting has no count to show.
          <s-box />
        ) : (
          <s-badge tone="critical">{count.toLocaleString("en")}</s-badge>
        )}
        {action ? (
          <s-stack direction="inline">
            <s-button variant="secondary" href={action.href}>
              {action.label}
            </s-button>
          </s-stack>
        ) : null}
      </s-grid>
    </s-stack>
  );
}
