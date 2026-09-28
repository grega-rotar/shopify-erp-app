import { boundary } from "@shopify/shopify-app-react-router/server";
import { useMemo, useState } from "react";
import {
  useFetcher,
  useLoaderData,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import {
  portalFailure,
  portalFor,
} from "~/adapters/export-portal/service.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import type { SourceType } from "~/domain/export-portal/contract";
import { readFieldValues } from "~/domain/export-portal/fields";
import { Dropdown } from "~/web/components/dropdown";
import {
  PortalFields,
  initialFieldState,
  type FieldState,
} from "~/web/components/portal-fields";
import {
  actorFromSession,
  principalFromSession,
} from "~/web/lib/principal.server";
import { redirectWithin } from "~/web/lib/redirects";
import { SOURCE_ROUTES } from "~/web/lib/sources";
import { readPortal } from "~/web/lib/sources.server";

/**
 * New source (docs/sources.md § Screens): pick what kind of export it is,
 * name it, and fill in the fields the portal says that kind has. Nothing
 * is created until the portal has accepted it; a refusal comes back
 * against the field it concerns.
 */
interface ActionResult {
  ok: false;
  message: string;
  fieldErrors: Record<string, string>;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  return {
    portal: await readPortal(principal, (client) => client.listSourceTypes()),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const actor = actorFromSession(session);
  const formData = await request.formData();

  const access = await portalFor(principal);
  if (!access.ok) {
    return {
      ok: false,
      message: access.message,
      fieldErrors: {},
    } satisfies ActionResult;
  }

  const kind = String(formData.get("kind") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const fieldErrors: Record<string, string> = {};
  if (kind === "") fieldErrors.kind = "Choose what kind of source this is.";
  if (name === "") fieldErrors.name = "Give the source a name.";

  try {
    const types = await access.client.listSourceTypes();
    const type = types.find((t) => t.kind === kind);
    if (kind !== "" && !type) {
      fieldErrors.kind = "The export portal no longer offers this kind.";
    }

    const read = type
      ? readFieldValues(type.fields, (key) => {
          const value = formData.get(key);
          return typeof value === "string" ? value : null;
        })
      : { values: {}, problems: [] };
    for (const problem of read.problems) {
      fieldErrors[problem.key] ??= problem.message;
    }

    if (Object.keys(fieldErrors).length > 0) {
      return {
        ok: false,
        message: "Some answers are missing or not right. Each one is marked.",
        fieldErrors,
      } satisfies ActionResult;
    }

    const source = await access.client.createSource({
      kind,
      name,
      values: read.values,
    });
    await appendEvent(principal, {
      entityType: "export_source",
      entityId: source.id,
      event: "export_source.created",
      detail: { name: source.name, kind: source.kind, actor },
    });
    return redirectWithin(request, SOURCE_ROUTES.source(source.id), {
      note: `${source.name} was created in the export portal.`,
    });
  } catch (error) {
    const failure = portalFailure(error);
    return {
      ok: false,
      message: failure.message,
      fieldErrors: failure.fieldErrors,
    } satisfies ActionResult;
  }
};

export default function NewSource() {
  const { portal } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data;
  const busy = fetcher.state !== "idle";
  const types = useMemo(
    () => (portal.kind === "read" ? portal.data : []),
    [portal],
  );

  const [kind, setKind] = useState(types.length === 1 ? types[0]!.kind : "");
  const [name, setName] = useState("");
  const [fieldState, setFieldState] = useState<FieldState>({});
  const chosen = types.find((t) => t.kind === kind) ?? null;
  const errors = result?.fieldErrors ?? {};

  const choose = (next: SourceType) => {
    setKind(next.kind);
    setFieldState(initialFieldState(next.fields, {}));
  };

  const submit = () =>
    fetcher.submit(
      { intent: "create", kind, name, ...fieldState },
      { method: "post" },
    );

  return (
    <s-page heading="New source" inlineSize="base">
      <s-link slot="breadcrumb-actions" href={SOURCE_ROUTES.index}>
        Sources
      </s-link>

      <s-stack direction="block" gap="large">
        {result && !result.ok ? (
          <s-banner tone="critical" heading="That did not work">
            <s-paragraph>{result.message}</s-paragraph>
          </s-banner>
        ) : null}

        {portal.kind !== "read" ? (
          <s-banner
            tone="warning"
            heading="The export portal could not be read"
          >
            <s-stack direction="block" gap="base">
              <s-paragraph>{portal.message}</s-paragraph>
              <s-stack direction="inline">
                <s-button href={SOURCE_ROUTES.index}>Back to sources</s-button>
              </s-stack>
            </s-stack>
          </s-banner>
        ) : null}

        {portal.kind === "read" ? (
          <s-section heading="1. Kind">
            <s-stack direction="block" gap="base">
              {types.length === 0 ? (
                <s-text color="subdued">
                  The export portal offers no kinds of source for this store.
                </s-text>
              ) : types.length <= 4 ? (
                <s-grid
                  gridTemplateColumns={`@container (inline-size <= 520px) 1fr, repeat(${types.length}, 1fr)`}
                  gap="small-300"
                >
                  {types.map((type) => {
                    const selected = type.kind === kind;
                    return (
                      <s-clickable
                        key={type.kind}
                        borderWidth="base"
                        borderStyle="solid"
                        borderColor={selected ? "strong" : "base"}
                        borderRadius="base"
                        background={selected ? "subdued" : "base"}
                        padding="small-300"
                        accessibilityLabel={`${type.label}${selected ? ", selected" : ""}`}
                        onClick={() => choose(type)}
                        {...(busy ? { disabled: true } : {})}
                      >
                        <s-grid
                          gridTemplateColumns="1fr auto"
                          gap="small-300"
                          alignItems="start"
                        >
                          <s-stack direction="block" gap="small-500">
                            <s-text type="strong">{type.label}</s-text>
                            {type.description ? (
                              <s-text color="subdued">
                                {type.description}
                              </s-text>
                            ) : null}
                          </s-stack>
                          {selected ? (
                            <s-icon type="check-circle-filled" />
                          ) : (
                            <s-box inlineSize="20px" />
                          )}
                        </s-grid>
                      </s-clickable>
                    );
                  })}
                </s-grid>
              ) : (
                <s-box maxInlineSize="520px">
                  <Dropdown
                    name="kind"
                    label="Kind"
                    value={kind}
                    options={types.map((t) => ({
                      value: t.kind,
                      label: t.label,
                    }))}
                    onChange={(value) => {
                      const next = types.find((t) => t.kind === value);
                      if (next) choose(next);
                    }}
                    {...(errors.kind ? { error: errors.kind } : {})}
                    {...(busy ? { disabled: true } : {})}
                  />
                </s-box>
              )}
              {errors.kind && types.length <= 4 ? (
                <s-text tone="critical">{errors.kind}</s-text>
              ) : null}
              {chosen?.description && types.length > 4 ? (
                <s-text color="subdued">{chosen.description}</s-text>
              ) : null}
            </s-stack>
          </s-section>
        ) : null}

        {portal.kind === "read" && chosen ? (
          <s-section heading="2. Name">
            <s-box maxInlineSize="520px">
              <s-text-field
                name="name"
                label="Name"
                details="How the source is listed here and in the portal."
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
                {...(errors.name ? { error: errors.name } : {})}
                {...(busy ? { disabled: true } : {})}
              />
            </s-box>
          </s-section>
        ) : null}

        {portal.kind === "read" && chosen ? (
          <s-section heading="3. Settings">
            {chosen.fields.length === 0 ? (
              <s-text color="subdued">
                This kind has nothing to configure.
              </s-text>
            ) : (
              <PortalFields
                fields={chosen.fields}
                values={{}}
                state={fieldState}
                errors={errors}
                onChange={(key, value) =>
                  setFieldState((current) => ({ ...current, [key]: value }))
                }
                disabled={busy}
              />
            )}
          </s-section>
        ) : null}

        {portal.kind === "read" && chosen ? (
          <s-stack direction="inline" gap="base">
            <s-button
              variant="primary"
              onClick={submit}
              {...(busy || name.trim() === "" ? { disabled: true } : {})}
              {...(busy ? { loading: true } : {})}
            >
              Create source
            </s-button>
            <s-button
              href={SOURCE_ROUTES.index}
              {...(busy ? { disabled: true } : {})}
            >
              Cancel
            </s-button>
          </s-stack>
        ) : null}
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
