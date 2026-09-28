import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  useLoaderData,
  useRevalidator,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { authenticate } from "~/adapters/shopify/shopify.server";
import { SettingRow } from "~/web/components/setting-row";
import { formatDateTime } from "~/web/lib/datetime";
import { useLiveRevalidation } from "~/web/lib/live";
import { principalFromSession } from "~/web/lib/principal.server";
import {
  RUN_STATUS_LABEL,
  SOURCE_ROUTES,
  isRunActive,
  runStatusTone,
} from "~/web/lib/sources";
import { readPortal } from "~/web/lib/sources.server";

/**
 * One run (docs/sources.md § Screens): what happened, when, how much it
 * carried, and the portal's log of it. Read-only; a run is the portal's
 * record and nothing here changes it. While it is still going the page
 * keeps asking.
 */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const sourceId = params.sourceId;
  const runId = params.runId;
  if (!sourceId || !runId) throw new Response("Not found", { status: 404 });

  const portal = await readPortal(principal, async (client) => {
    const [source, detail] = await Promise.all([
      client.getSource(sourceId),
      client.getRun(runId),
    ]);
    // A run reached through another source's address is not shown: the
    // portal scopes runs by tenant, and this keeps the page's breadcrumb
    // honest as well.
    if (detail.run.sourceId !== sourceId) {
      throw new Response("Not found", { status: 404 });
    }
    return { source, run: detail.run, log: detail.log };
  });
  return { sourceId, portal };
};

export default function RunPage() {
  const { sourceId, portal } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const active = portal.kind === "read" && isRunActive(portal.data.run);

  // A finished run does not change; only a running one is followed.
  useLiveRevalidation({ active, idleEveryMs: null });

  if (portal.kind !== "read") {
    return (
      <s-page heading="Run">
        <s-link slot="breadcrumb-actions" href={SOURCE_ROUTES.source(sourceId)}>
          Source
        </s-link>
        <s-banner tone="warning" heading="The run could not be read">
          <s-stack direction="block" gap="base">
            <s-paragraph>{portal.message}</s-paragraph>
            <s-stack direction="inline">
              <s-button
                onClick={() => void revalidator.revalidate()}
                {...(revalidator.state !== "idle"
                  ? { disabled: true, loading: true }
                  : {})}
              >
                Try again
              </s-button>
            </s-stack>
          </s-stack>
        </s-banner>
      </s-page>
    );
  }

  const { source, run, log } = portal.data;
  const tone = runStatusTone(run.status);

  return (
    <s-page
      heading={`${source.name} · ${run.startedAt ? formatDateTime(run.startedAt) : RUN_STATUS_LABEL[run.status]}`}
    >
      <s-link slot="breadcrumb-actions" href={SOURCE_ROUTES.source(source.id)}>
        {source.name}
      </s-link>

      {run.downloadUrl ? (
        <s-button slot="primary-action" href={run.downloadUrl} target="_blank">
          Download file
        </s-button>
      ) : null}

      <s-stack direction="block" gap="large">
        {run.status === "failed" && run.message ? (
          <s-banner tone="critical" heading="The run failed">
            <s-paragraph>{run.message}</s-paragraph>
          </s-banner>
        ) : null}

        <s-section heading="Run">
          <s-stack direction="block" gap="base">
            <SettingRow
              label="Status"
              summary={
                run.message && run.status !== "failed"
                  ? run.message
                  : RUN_STATUS_LABEL[run.status]
              }
              action={
                <s-badge {...(tone ? { tone } : {})}>
                  {RUN_STATUS_LABEL[run.status]}
                </s-badge>
              }
            />
            <SettingRow
              label="Started"
              summary={
                run.startedAt
                  ? formatDateTime(run.startedAt)
                  : run.queuedAt
                    ? `Queued ${formatDateTime(run.queuedAt)}, not started yet.`
                    : "Not started yet."
              }
            />
            <SettingRow
              label="Finished"
              summary={
                run.finishedAt
                  ? formatDateTime(run.finishedAt)
                  : "Not finished."
              }
            />
            <SettingRow
              label="Items"
              summary={
                run.itemCount === null || run.itemCount === undefined
                  ? "Not counted."
                  : `${run.itemCount.toLocaleString("en")} ${run.itemCount === 1 ? "item" : "items"}.`
              }
            />
            {run.triggeredBy ? (
              <SettingRow label="Started by" summary={run.triggeredBy} />
            ) : null}
          </s-stack>
        </s-section>

        <s-section heading="Log">
          {log.length === 0 ? (
            <s-text color="subdued">
              {active
                ? "Nothing logged yet."
                : "The portal kept no log for this run."}
            </s-text>
          ) : (
            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header listSlot="secondary">When</s-table-header>
                <s-table-header listSlot="primary">Message</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {log.map((line, index) => (
                  <s-table-row key={`${line.at}-${index}`}>
                    <s-table-cell>
                      <s-text color="subdued">{formatDateTime(line.at)}</s-text>
                    </s-table-cell>
                    <s-table-cell>
                      <s-text
                        {...(line.level === "error"
                          ? { tone: "critical" }
                          : line.level === "warning"
                            ? { tone: "caution" }
                            : {})}
                      >
                        {line.message}
                      </s-text>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
        </s-section>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
