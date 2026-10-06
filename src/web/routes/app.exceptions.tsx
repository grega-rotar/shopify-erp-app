import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";
import { z } from "zod";

import type { ExceptionKind } from "@prisma/client";

import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import {
  countOpenExceptionsByKind,
  listExceptions,
  listOpenExceptionsByKind,
  resolveException,
} from "~/adapters/db/repositories/exception.server";
import {
  recordExceptionAttempt,
  redriveOrder,
  TARGET_FOR_KIND,
} from "~/adapters/queue/redrive.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { LearnMore } from "~/web/components/learn-more";
import { formatListDateTime } from "~/web/lib/datetime";
import {
  areaOfKind,
  ATTENTION_AREAS,
  describeExceptionKind,
  EXCEPTIONS_PAGE_SIZE,
  isAttentionArea,
  limitParamFor,
  parseExceptionsLimit,
} from "~/web/lib/exceptions";
import { principalFromSession } from "~/web/lib/principal.server";
import { TRANSLATION_ROUTES } from "~/web/lib/translations";

/**
 * The exceptions queue (CLAUDE.md §11).
 *
 * An exception is a business condition needing a person — not a retryable
 * failure, which the queue handles silently, and not a form validation error.
 * Each row says what happened, what it means and what to do about it, and
 * offers the three things a merchant can actually do: retry it, ignore it, or
 * mark it dealt with.
 *
 * Nothing here writes to MetaKocka directly. "Retry" re-queues the job that
 * answers *this* problem — `redrive.server` decides which — so the duplicate
 * guard and the warehouse validation still apply. It used to re-queue the
 * allocation whatever had gone wrong, which for a rejected sales order meant
 * re-running the one step that had never failed, and the button appeared to do
 * nothing.
 *
 * Most of these never need the button at all. `recheck-exceptions` runs every
 * quarter of an hour, closes the ones that have fixed themselves and re-drives
 * the ones that can now succeed, so what is left here is what genuinely still
 * needs a person.
 */
/** The campaign a sale exception names in its detail, if any. */
function campaignIdOf(detail: unknown): string | null {
  if (!detail || typeof detail !== "object") return null;
  const id = (detail as { campaignId?: unknown }).campaignId;
  return typeof id === "string" && id !== "" ? id : null;
}

const translationDetailSchema = z.object({
  syncId: z.string().min(1).optional(),
  resourceId: z.string().min(1).optional(),
  resourceType: z.string().min(1).optional(),
  title: z.string().optional(),
  locales: z.array(z.string()).optional(),
});

/**
 * What a translation exception is about: the resource, opened in the editor
 * in the language that failed, and the sync that found it. Rows raised
 * before resources were named carry only the sync.
 */
function translationLinksOf(detail: unknown): {
  subject: { label: string; href: string } | null;
  syncHref: string | null;
} {
  const parsed = translationDetailSchema.safeParse(detail);
  if (!parsed.success) return { subject: null, syncHref: null };
  const { syncId, resourceId, resourceType, title, locales } = parsed.data;
  const syncHref = syncId ? TRANSLATION_ROUTES.sync(syncId) : null;
  if (!resourceId || !resourceType) return { subject: null, syncHref };
  const search = new URLSearchParams({
    locale: locales?.[0] ?? "",
    type: resourceType,
    resource: resourceId,
    rtype: resourceType,
  });
  return {
    subject: {
      label: title || resourceId,
      href: `${TRANSLATION_ROUTES.editor}?${search.toString()}`,
    },
    syncHref,
  };
}

/** The first column names what a row is about, which is an order for most kinds. */
function subjectHeading(kind: string): string {
  if (kind === "translation_failed") return "Content";
  if (kind.startsWith("sale_")) return "Campaign";
  return "Order";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  const url = new URL(request.url);

  const [counts, resolved] = await Promise.all([
    countOpenExceptionsByKind(principal),
    listExceptions(principal, { status: "resolved", limit: 10 }),
  ]);

  const shape = (rows: Awaited<ReturnType<typeof listOpenExceptionsByKind>>) =>
    rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      message: row.message,
      createdAt: row.createdAt.toISOString(),
      orderId: row.order?.id ?? null,
      orderNumber: row.order?.shopifyOrderNumber ?? null,
      // A sale campaign's exception belongs to the campaign, not to an order.
      campaignId: campaignIdOf(row.detail),
      // A translation exception belongs to a product or page, and a sync.
      ...(row.kind === "translation_failed"
        ? translationLinksOf(row.detail)
        : { subject: null, syncHref: null }),
      // What has already been tried, so a retry that keeps failing stops
      // looking like a button that does not work.
      attempts: row.attempts,
      lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
      lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
      resolvedBy: row.resolvedBy,
    }));

  /*
   * Grouped by kind, because the guidance is per kind — and paged by kind too.
   *
   * A single limit across every kind, ordered by recency, meant a category
   * with nothing recent in it simply never appeared: its rows existed but
   * never made it into the shared top-N, and there was no "Load more" to find
   * because the category itself was invisible. Every kind with at least one
   * open exception gets its own section and its own `limit_<kind>` page size,
   * so loading more of one never hides or resets another.
   */
  /*
   * Home links here by area (`?area=orders`): one row there is that area's
   * kinds here. An area this page does not know is ignored rather than
   * showing an empty page.
   */
  const requestedArea = url.searchParams.get("area") ?? "";
  const area = isAttentionArea(requestedArea) ? requestedArea : null;

  const kinds = [...counts.keys()]
    .filter((kind) => area === null || areaOfKind(kind) === area)
    .sort(
      // Biggest first: the thing that has gone wrong most is the thing worth
      // dealing with first, and it is usually one fix for all of them.
      (a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0),
    );

  const groups = await Promise.all(
    kinds.map(async (kind) => {
      const limit = parseExceptionsLimit(
        url.searchParams.get(limitParamFor(kind)),
      );
      const rows = await listOpenExceptionsByKind(principal, kind, { limit });
      const count = counts.get(kind) ?? 0;
      return {
        kind,
        limit,
        rows: shape(rows),
        count,
        hasMore: rows.length < count,
        // Retrying a whole group only makes sense where a retry does something.
        retryable: TARGET_FOR_KIND[kind] !== "none",
      };
    }),
  );

  const total = [...counts.values()].reduce((sum, n) => sum + n, 0);

  return {
    groups,
    total,
    area: area ? { key: area, label: ATTENTION_AREAS[area].label } : null,
    resolved: shape(resolved),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const id = String(formData.get("id") ?? "");
  const orderId = String(formData.get("orderId") ?? "");

  if (intent === "retry") {
    if (!orderId) {
      return {
        ok: false,
        message:
          "This issue is not attached to an order, so there is nothing to retry.",
      };
    }

    const kind = String(formData.get("kind") ?? "");
    const target =
      kind in TARGET_FOR_KIND
        ? TARGET_FOR_KIND[kind as keyof typeof TARGET_FOR_KIND]
        : "auto";

    const { queued, reason } = await redriveOrder(principal, orderId, target);

    if (queued.length === 0) {
      return {
        ok: false,
        message:
          reason ??
          "There is nothing to retry for this order. Open it to see where it has got to.",
      };
    }

    if (id) await recordExceptionAttempt(principal, id, new Date());

    return {
      ok: true,
      // Says what it is doing, not that it is doing something. A retry that
      // fails the same way is a fact worth being able to see.
      message: `Retrying: ${queued.join(", ")}. This closes itself if it succeeds.`,
    };
  }

  if (intent === "retry-kind" || intent === "resolve-kind") {
    /*
     * Everything of one kind, in one press.
     *
     * The same fix usually clears a whole kind at once — a gateway mapped, a
     * profit centre created, stock delivered — so making the merchant press the
     * same button once per order is asking them to do the app's arithmetic.
     */
    const kind = String(formData.get("kind") ?? "") as ExceptionKind;
    const open = await listOpenExceptionsByKind(principal, kind);
    // Resolving needs nothing but the row; retrying redrives an order, so it
    // only applies to rows that have one. An orderless stock exception used
    // to be excluded from both, which meant it could never be bulk-resolved
    // even though marking it dealt with needs no order at all.
    const mine =
      intent === "resolve-kind" ? open : open.filter((row) => row.order);

    if (mine.length === 0) {
      return { ok: false, message: "There is nothing left of that kind." };
    }

    if (intent === "resolve-kind") {
      for (const row of mine) {
        await resolveException(principal, row.id, {
          status: "resolved",
          by: session.shop,
        });
      }
      return {
        ok: true,
        message: `Marked ${mine.length} ${mine.length === 1 ? "issue" : "issues"} resolved.`,
      };
    }

    const target =
      kind in TARGET_FOR_KIND
        ? TARGET_FOR_KIND[kind as keyof typeof TARGET_FOR_KIND]
        : "auto";

    let queued = 0;
    for (const row of mine) {
      if (!row.order) continue;
      const outcome = await redriveOrder(principal, row.order.id, target);
      if (outcome.queued.length > 0) {
        queued += 1;
        await recordExceptionAttempt(principal, row.id, new Date());
      }
    }

    return {
      ok: queued > 0,
      message:
        queued > 0
          ? `Retrying ${queued} ${queued === 1 ? "order" : "orders"} in the background. Each one clears itself if it succeeds.`
          : "None of those could be retried. Open one to see where it has got to.",
    };
  }

  if (intent === "resolve" || intent === "ignore") {
    await resolveException(principal, id, {
      status: intent === "resolve" ? "resolved" : "ignored",
      // §9: identity comes from the App Bridge session; there is no user table.
      by: session.shop,
    });

    await appendEvent(principal, {
      entityType: "exception",
      entityId: id,
      event: "exception.closed",
      detail: { how: intent },
    });

    return {
      ok: true,
      message:
        intent === "resolve"
          ? "Marked as resolved."
          : "Ignored. It will not come back unless it happens again.",
    };
  }

  return { ok: false, message: "Unknown action." };
};

/**
 * What happened, without the subject the row already names: the message
 * opens with the item in quotes ("“Aeryn - P1 Pocket Wing” could not be
 * translated…"), which the first column shows as a link.
 */
function reasonOf(message: string): string {
  const rest = message.replace(/^[“"][^”"]*[”"]\s+/, "");
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

export default function Exceptions() {
  const { groups, total, area, resolved } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const busy = navigation.state === "submitting";
  const post = (fields: Record<string, string>) =>
    submit(fields, { method: "post" });

  return (
    <s-page heading="Needs attention" inlineSize="large">
      <s-link slot="breadcrumb-actions" href="/app">
        Home
      </s-link>

      <s-query-container>
        <s-stack direction="block" gap="base">
          {result ? (
            <s-banner
              tone={result.ok ? "info" : "critical"}
              heading={result.ok ? "Done" : "That did not work"}
            >
              <s-paragraph>{result.message}</s-paragraph>
            </s-banner>
          ) : null}

          {/* Reached from a Home row: say what is left out, and how to see it. */}
          {area && total > 0 ? (
            <s-stack direction="inline" gap="small-300" alignItems="center">
              <s-text color="subdued">
                {groups.length > 0
                  ? `Showing ${area.label.toLowerCase()} only.`
                  : `Nothing in ${area.label.toLowerCase()} needs attention now.`}
              </s-text>
              <s-link href="/app/exceptions">{`Show all ${total}`}</s-link>
            </s-stack>
          ) : null}

          {total === 0 ? (
            <s-section>
              <s-stack direction="block" gap="small-300">
                <s-heading>Nothing needs attention</s-heading>
                <s-text color="subdued">
                  Problems with orders, stock, sales and translations show up
                  here with what to do about them. Anything that fixes itself is
                  retried and cleared every fifteen minutes.
                </s-text>
              </s-stack>
            </s-section>
          ) : (
            /*
             * One card per kind of problem: the advice belongs to the kind and
             * is said once, the rows say only what differs, and the bulk
             * action — usually the right one — sits in the card's header.
             */
            groups.map((group) => {
              const copy = describeExceptionKind(group.kind);
              const count = group.count;
              const loaded = group.rows.length;

              return (
                <s-section key={group.kind} padding="none">
                  <s-stack direction="block" gap="none">
                    <s-box padding="base">
                      <s-stack direction="block" gap="small-300">
                        <s-grid
                          gridTemplateColumns="@container (inline-size <= 640px) 1fr, 1fr auto"
                          gap="small-300"
                          alignItems="center"
                        >
                          <s-stack
                            direction="inline"
                            gap="small-300"
                            alignItems="center"
                          >
                            <s-heading>{copy.label}</s-heading>
                            <s-badge>{count.toLocaleString("en")}</s-badge>
                          </s-stack>
                          {count > 1 ? (
                            <s-stack direction="inline" gap="small-300">
                              {group.retryable ? (
                                <s-button
                                  onClick={() =>
                                    post({
                                      intent: "retry-kind",
                                      kind: group.kind,
                                    })
                                  }
                                  {...(busy ? { disabled: true } : {})}
                                >
                                  {`Retry all ${count}`}
                                </s-button>
                              ) : null}
                              <s-button
                                onClick={() =>
                                  post({
                                    intent: "resolve-kind",
                                    kind: group.kind,
                                  })
                                }
                                {...(busy ? { disabled: true } : {})}
                              >
                                {`Resolve all ${count}`}
                              </s-button>
                            </s-stack>
                          ) : null}
                        </s-grid>
                        <LearnMore label="What to do">
                          <s-paragraph>{copy.guidance}</s-paragraph>
                        </LearnMore>
                      </s-stack>
                    </s-box>

                    {/*
                     * `variant="auto"` turns the columns into a labelled list
                     * on a narrow screen rather than scrolling sideways.
                     */}
                    <s-table variant="auto">
                      <s-table-header-row>
                        <s-table-header listSlot="primary">
                          {subjectHeading(group.kind)}
                        </s-table-header>
                        <s-table-header listSlot="labeled">
                          Since
                        </s-table-header>
                        <s-table-header listSlot="inline">
                          <s-text accessibilityVisibility="exclusive">
                            Actions
                          </s-text>
                        </s-table-header>
                      </s-table-header-row>

                      <s-table-body>
                        {group.rows.map((exception) => {
                          const menuId = `exception-menu-${exception.id}`;
                          const canRetry = Boolean(
                            exception.orderId && group.retryable,
                          );
                          return (
                            <s-table-row key={exception.id}>
                              <s-table-cell>
                                <s-stack direction="block" gap="none">
                                  {exception.orderNumber &&
                                  exception.orderId ? (
                                    <s-link
                                      href={`/app/orders/${exception.orderId}`}
                                    >
                                      {exception.orderNumber}
                                    </s-link>
                                  ) : exception.campaignId ? (
                                    <s-link
                                      href={`/app/sales/${exception.campaignId}/variants`}
                                    >
                                      Open campaign
                                    </s-link>
                                  ) : exception.subject ? (
                                    <s-link href={exception.subject.href}>
                                      {exception.subject.label}
                                    </s-link>
                                  ) : (
                                    <s-text type="strong">
                                      {group.kind === "translation_failed"
                                        ? "Not named"
                                        : "No order"}
                                    </s-text>
                                  )}
                                  <s-text color="subdued">
                                    {reasonOf(exception.message)}
                                  </s-text>
                                  {/*
                                   * What has already been tried: without it, a
                                   * row retried four times looks like one
                                   * nobody has touched.
                                   */}
                                  {exception.attempts > 0 ? (
                                    <s-text color="subdued">
                                      {`Tried ${exception.attempts} ${exception.attempts === 1 ? "time" : "times"}${
                                        exception.lastAttemptAt
                                          ? `, last ${formatListDateTime(exception.lastAttemptAt)}`
                                          : ""
                                      }.`}
                                    </s-text>
                                  ) : null}
                                </s-stack>
                              </s-table-cell>

                              <s-table-cell>
                                <s-text color="subdued">
                                  {formatListDateTime(exception.createdAt)}
                                </s-text>
                              </s-table-cell>

                              <s-table-cell>
                                <s-stack
                                  direction="inline"
                                  gap="small-300"
                                  justifyContent="end"
                                >
                                  <s-button
                                    onClick={() =>
                                      post({
                                        intent: "resolve",
                                        id: exception.id,
                                      })
                                    }
                                    {...(busy ? { disabled: true } : {})}
                                  >
                                    Resolve
                                  </s-button>
                                  <s-button
                                    icon="menu-horizontal"
                                    accessibilityLabel="More actions"
                                    command="--toggle"
                                    commandFor={menuId}
                                    {...(busy ? { disabled: true } : {})}
                                  />
                                  <s-menu
                                    id={menuId}
                                    accessibilityLabel="More actions"
                                  >
                                    {exception.syncHref ? (
                                      <s-button href={exception.syncHref}>
                                        Open sync
                                      </s-button>
                                    ) : null}
                                    {canRetry ? (
                                      <s-button
                                        onClick={() =>
                                          post({
                                            intent: "retry",
                                            orderId: exception.orderId ?? "",
                                            id: exception.id,
                                            kind: exception.kind,
                                          })
                                        }
                                      >
                                        Retry
                                      </s-button>
                                    ) : null}
                                    <s-button
                                      onClick={() =>
                                        post({
                                          intent: "ignore",
                                          id: exception.id,
                                        })
                                      }
                                    >
                                      Ignore
                                    </s-button>
                                  </s-menu>
                                </s-stack>
                              </s-table-cell>
                            </s-table-row>
                          );
                        })}
                      </s-table-body>
                    </s-table>

                    {group.hasMore ? (
                      <s-box padding="base">
                        <s-grid
                          gridTemplateColumns="1fr auto"
                          gap="base"
                          alignItems="center"
                        >
                          <s-text color="subdued">
                            {`Showing ${loaded} of ${count.toLocaleString("en")}`}
                          </s-text>
                          {/*
                           * Paging is per category: the hidden inputs carry
                           * every other category's current limit unchanged,
                           * so loading more of this one never resets another.
                           */}
                          <Form method="get">
                            {area ? (
                              <input
                                type="hidden"
                                name="area"
                                value={area.key}
                              />
                            ) : null}
                            {groups.map((g) => (
                              <input
                                key={g.kind}
                                type="hidden"
                                name={limitParamFor(g.kind)}
                                value={
                                  g.kind === group.kind
                                    ? group.limit + EXCEPTIONS_PAGE_SIZE
                                    : g.limit
                                }
                              />
                            ))}
                            <s-button
                              type="submit"
                              {...(busy ? { disabled: true } : {})}
                            >
                              Load more
                            </s-button>
                          </Form>
                        </s-grid>
                      </s-box>
                    ) : null}
                  </s-stack>
                </s-section>
              );
            })
          )}

          {resolved.length > 0 ? (
            <s-section>
              <s-stack direction="block" gap="small-300">
                <s-heading>Recently closed</s-heading>
                {resolved.map((exception) => (
                  <s-text key={exception.id} color="subdued">
                    {`${describeExceptionKind(exception.kind).label}${
                      exception.orderNumber
                        ? ` · order ${exception.orderNumber}`
                        : ""
                    } · ${formatListDateTime(exception.createdAt)}${
                      exception.resolvedBy === "app"
                        ? " · cleared automatically once fixed"
                        : ""
                    }`}
                  </s-text>
                ))}
              </s-stack>
            </s-section>
          ) : null}
        </s-stack>
      </s-query-container>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
