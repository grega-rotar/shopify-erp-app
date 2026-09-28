import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect } from "react";
import {
  useLoaderData,
  useRevalidator,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { authenticate } from "~/adapters/shopify/shopify.server";
import { RunsTable } from "~/web/components/source-overview";
import { principalFromSession } from "~/web/lib/principal.server";
import { SOURCE_ROUTES, isRunActive } from "~/web/lib/sources";
import { readPortal } from "~/web/lib/sources.server";

/**
 * Every run of one source the portal remembers (docs/sources.md §
 * Screens), where the source's own page shows only the latest few.
 * Read-only; while one is still going the page keeps asking.
 */
const RUNS_SHOWN = 100;

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const sourceId = params.sourceId;
  if (!sourceId) throw new Response("Not found", { status: 404 });

  const portal = await readPortal(principal, async (client) => {
    const [source, runs] = await Promise.all([
      client.getSource(sourceId),
      client.listRuns(sourceId, RUNS_SHOWN),
    ]);
    return { source, runs };
  });
  return { sourceId, portal };
};

export default function SourceRunsPage() {
  const { sourceId, portal } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const active =
    portal.kind === "read" && portal.data.runs.some((run) => isRunActive(run));

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (revalidator.state === "idle") void revalidator.revalidate();
    }, 5000);
    return () => clearInterval(timer);
  }, [active, revalidator]);

  if (portal.kind !== "read") {
    return (
      <s-page heading="Runs">
        <s-link slot="breadcrumb-actions" href={SOURCE_ROUTES.source(sourceId)}>
          Source
        </s-link>
        <s-banner tone="warning" heading="The runs could not be read">
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

  const { source, runs } = portal.data;

  return (
    <s-page heading={`${source.name} · Runs`} inlineSize="large">
      <s-link slot="breadcrumb-actions" href={SOURCE_ROUTES.source(source.id)}>
        {source.name}
      </s-link>

      <s-section accessibilityLabel="Runs">
        {runs.length === 0 ? (
          <s-text color="subdued">No runs yet.</s-text>
        ) : (
          <s-stack direction="block" gap="base">
            <RunsTable sourceId={source.id} runs={runs} />
            {runs.length >= RUNS_SHOWN ? (
              <s-text color="subdued">
                {`The latest ${RUNS_SHOWN} runs. Older ones are in the export portal.`}
              </s-text>
            ) : null}
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
