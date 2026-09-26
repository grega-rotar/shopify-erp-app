import type { ReactNode } from "react";

/**
 * A form beside its summary on a full-width page (docs/ui-conventions.md
 * § Editors with a summary): the form takes what is left, the summary a
 * fixed column that stays in view as the form scrolls, and on a narrow
 * page the summary follows the form.
 *
 * `s-page`'s own `aside` slot only draws at `inlineSize="base"`, which caps
 * the page at a narrow column; this is the same shape on a `large` page.
 * The query container is what the breakpoint measures against — an
 * unnamed responsive value needs one.
 */
export function PageColumns({
  aside,
  children,
}: {
  aside: ReactNode;
  children: ReactNode;
}) {
  return (
    <s-query-container>
      <s-grid
        gridTemplateColumns="@container (inline-size <= 900px) 1fr, 'minmax(0, 1fr) 360px'"
        gap="base"
        alignItems="start"
      >
        <s-stack direction="block" gap="large">
          {children}
        </s-stack>
        <div
          style={{
            position: "sticky",
            top: "1rem",
            maxHeight: "calc(100vh - 2rem)",
            overflowY: "auto",
          }}
        >
          {aside}
        </div>
      </s-grid>
    </s-query-container>
  );
}

/**
 * Two cards side by side on a full-width page, as tall as the taller, one
 * under the other on a narrow one. For two short sections that would each
 * be a flat, wide card on their own.
 */
export function Columns({ children }: { children: ReactNode }) {
  return (
    <s-query-container>
      <s-grid
        gridTemplateColumns="@container (inline-size <= 900px) 1fr, 'minmax(0, 1fr) minmax(0, 1fr)'"
        gap="base"
        alignItems="stretch"
      >
        {children}
      </s-grid>
    </s-query-container>
  );
}
