import { boundary } from "@shopify/shopify-app-react-router/server";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  useFetcher,
  useLoaderData,
  useNavigate,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
  type ShouldRevalidateFunction,
} from "react-router";
import { z } from "zod";

import { detectLanguage, isConfigured } from "~/adapters/ai/openai.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import {
  forgetMemory,
  rememberTranslations,
} from "~/adapters/db/repositories/translation-intelligence.server";
import {
  forgetOwnership,
  getSourceOverride,
  listOwnership,
  recordOwnership,
  setSourceOverride,
  recordDetectedSource,
} from "~/adapters/db/repositories/translations.server";
import { listShopLocales } from "~/adapters/shopify/locales";
import { readNavigationTree } from "~/adapters/shopify/navigation";
import { authenticate } from "~/adapters/shopify/shopify.server";
import {
  isLocaleCode,
  isSearchable,
  readResourceCards,
  readTranslatableResources,
  readTranslatableResourcesByIds,
  registerTranslations,
  removeTranslations,
  resourceTitle,
  searchResourceIds,
  type TranslatableResource,
} from "~/adapters/shopify/translations";
import { ContextSource } from "~/adapters/translations/context.server";
import { hashValue } from "~/adapters/translations/engine.server";
import { translateResourceNow } from "~/adapters/translations/inline.server";
import {
  describeConfidence,
  detectionSample,
} from "~/domain/translations/detection";
import { isMemorable, memoryKey } from "~/domain/translations/memory";
import { classifyField, isTranslatableField } from "~/domain/translations/plan";
import {
  ALL_CONTENT_GROUPS,
  ALL_RESOURCE_TYPES,
  CONTENT_GROUPS,
  FIELD_STATE_LABEL,
  RESOURCE_TYPE_LABEL,
  fieldLabel,
  groupForType,
  isResourceType,
  resourceTypeOfId,
  type FieldState,
  type OwnershipRecord,
  type ResourceType,
} from "~/domain/translations/types";
import { Dropdown } from "~/web/components/dropdown";
import {
  HtmlEditor,
  HtmlPreview,
  HtmlSource,
  HtmlViewSwitch,
  type HtmlView,
} from "~/web/components/html-editor";
import { TranslationsNav } from "~/web/components/translations-nav";
import { formatListDateTime } from "~/web/lib/datetime";
import { needsSourceEditing } from "~/web/lib/html";
import {
  actorFromSession,
  principalFromSession,
} from "~/web/lib/principal.server";
import {
  TRANSLATION_ROUTES,
  describeResourceId,
  localeLabel,
} from "~/web/lib/translations";
import { useResetWhenSaved } from "~/web/lib/use-save-bar";

/**
 * The translation workspace (docs/translations.md § Editor): an index of
 * resources — search, filters, a page of rows — and, over it, the one
 * chosen resource in a dialog with every field's source beside its
 * translation.
 *
 * Choosing a resource never leaves the page. The index is what the route
 * loader reads — a page of Shopify's `translatableResources`, filtered here
 * because Shopify offers no query on that connection — and the chosen
 * resource is a second, smaller read of the same loader (`part=resource`)
 * made from the browser. The address is kept current so a reload or a
 * bookmark opens the same resource, but `shouldRevalidate` keeps a change of
 * resource from re-reading the whole index.
 *
 * Saving is `translationsRegister` — the translation lands in Shopify and
 * nowhere else — and records the field as a person's work, which the AI
 * then leaves alone. An emptied field is `translationsRemove`. The source
 * language a resource is written in is shown and can be changed here;
 * detection only suggests.
 */
const PAGE = 25;
/** Resources read per request while scanning for a state filter, and the most read for one page. */
const SCAN_PAGE = 100;
const SCAN_CAP = 600;
/** "All kinds": this many of each. */
const ALL_PER_KIND = 8;
const ALL_TYPES = "all";
type ListType = ResourceType | typeof ALL_TYPES;
const CARD_TYPES = new Set<ResourceType>(["PRODUCT", "COLLECTION", "ARTICLE"]);

/**
 * A row of the index: the resource behind it when Shopify has one, what its
 * fields are in the language, and where it sits in a tree — navigation is
 * menus with their items nested, everything else a flat list at depth 0.
 */
interface Listed {
  id: string;
  title: string;
  type: ResourceType;
  resource: TranslatableResource | null;
  states: StateCounts;
  depth: number;
  parentId: string | null;
  childCount: number;
}

const NO_STATES: StateCounts = {
  missing: 0,
  outdated: 0,
  manual: 0,
  ai: 0,
  existing: 0,
};

/** The kinds that are one tree rather than two lists. */
const NAVIGATION_TYPES = new Set<ResourceType>(["MENU", "LINK"]);

/**
 * The kind of the resource the address names: told by the row that opened
 * it (`rtype`), else read off the id — "All kinds" lists every kind and the
 * intents on a resource need to know which.
 */
function selectedType(
  url: URL,
  resourceId: string,
  listType: ListType,
): ResourceType {
  const told = url.searchParams.get("rtype") ?? "";
  if (isResourceType(told)) return told;
  return (
    resourceTypeOfId(resourceId) ??
    (listType === ALL_TYPES ? "PRODUCT" : listType)
  );
}

const STATUS_FILTERS = ["all", "missing", "outdated", "manual", "ai"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

const STATUS_FILTER_LABEL: Record<StatusFilter, string> = {
  all: "Everything",
  missing: "Missing",
  outdated: "Outdated",
  manual: "Edited by a person",
  ai: "Written by AI",
};

function isStatusFilter(value: string): value is StatusFilter {
  return (STATUS_FILTERS as readonly string[]).includes(value);
}

interface ListParams {
  locale: string;
  type: ListType;
  status: StatusFilter;
  q: string;
  after?: string | null;
}

function editorUrl(
  params: ListParams & {
    resource?: string | null;
    resourceType?: ResourceType | null;
    part?: "resource";
  },
): string {
  const search = new URLSearchParams();
  search.set("locale", params.locale);
  search.set("type", params.type);
  if (params.status !== "all") search.set("status", params.status);
  if (params.q) search.set("q", params.q);
  if (params.after) search.set("after", params.after);
  if (params.resource) search.set("resource", params.resource);
  if (params.resource && params.resourceType)
    search.set("rtype", params.resourceType);
  if (params.part) search.set("part", params.part);
  return `${TRANSLATION_ROUTES.editor}?${search.toString()}`;
}

interface StateCounts {
  missing: number;
  outdated: number;
  manual: number;
  ai: number;
  existing: number;
}

function countStates(
  resource: TranslatableResource,
  locale: string,
  ownership: readonly OwnershipRecord[],
): StateCounts {
  const counts: StateCounts = {
    missing: 0,
    outdated: 0,
    manual: 0,
    ai: 0,
    existing: 0,
  };
  const translations = new Map(
    (resource.translations.get(locale) ?? []).map((t) => [t.key, t]),
  );
  const records = new Map(
    ownership.filter((r) => r.locale === locale).map((r) => [r.key, r]),
  );
  for (const field of resource.fields) {
    if (!isTranslatableField(field)) continue;
    const state = classifyField(
      translations.get(field.key),
      records.get(field.key),
      hashValue,
    );
    counts[state] += 1;
  }
  return counts;
}

/** One resource as the editor pane shows it. */
function describeSelected(
  resource: TranslatableResource,
  type: ResourceType,
  locale: string,
  primaryLocale: string,
  ownership: readonly OwnershipRecord[],
  override: { sourceLocale: string; detectedLocale: string | null } | null,
) {
  const translations = new Map(
    (resource.translations.get(locale) ?? []).map((t) => [t.key, t]),
  );
  const records = new Map(
    ownership.filter((r) => r.locale === locale).map((r) => [r.key, r]),
  );
  return {
    id: resource.resourceId,
    type,
    title: resourceTitle(resource.fields, resource.resourceId),
    sourceLocale: override?.sourceLocale ?? primaryLocale,
    sourceIsOverride:
      override !== null && override.sourceLocale !== primaryLocale,
    detectedLocale: override?.detectedLocale ?? null,
    fields: resource.fields
      .filter((field) => field.digest !== null)
      .map((field) => {
        const translation = translations.get(field.key);
        return {
          key: field.key,
          label: fieldLabel(field.key),
          type: field.type,
          source: field.value,
          digest: field.digest ?? "",
          translation: translation?.value ?? "",
          state: classifyField(translation, records.get(field.key), hashValue),
          outdated: translation?.outdated ?? false,
          updatedAt: translation?.updatedAt ?? null,
          prose: isTranslatableField(field),
        };
      }),
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const url = new URL(request.url);

  const locales = await listShopLocales(admin);
  if (locales.kind === "unavailable")
    return { kind: "unavailable" as const, reason: locales.reason };
  const primary = locales.locales.find((l) => l.primary);
  if (!primary)
    return {
      kind: "unavailable" as const,
      reason: "Shopify reports no default language.",
    };
  const targets = locales.locales.filter((l) => !l.primary);
  if (targets.length === 0)
    return {
      kind: "no-languages" as const,
      primary: { locale: primary.locale, name: primary.name },
    };

  const wanted = url.searchParams.get("locale") ?? "";
  const locale = targets.some((l) => l.locale === wanted)
    ? wanted
    : (targets[0]?.locale ?? "");
  const typeParam = url.searchParams.get("type") ?? "PRODUCT";
  const type: ListType =
    typeParam === ALL_TYPES
      ? ALL_TYPES
      : isResourceType(typeParam)
        ? typeParam
        : "PRODUCT";
  const statusParam = url.searchParams.get("status") ?? "all";
  const status: StatusFilter = isStatusFilter(statusParam)
    ? statusParam
    : "all";
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
  const after = url.searchParams.get("after");
  const selectedId = url.searchParams.get("resource");

  // The small read: one resource for the dialog, nothing for the index.
  if (url.searchParams.get("part") === "resource") {
    if (!selectedId) return { kind: "resource" as const, selected: null };
    const [read, ownership, override] = await Promise.all([
      readTranslatableResourcesByIds(admin, {
        ids: [selectedId],
        locales: [locale],
      }),
      listOwnership(principal, [selectedId]),
      getSourceOverride(principal, selectedId),
    ]);
    const resource = read[0];
    return {
      kind: "resource" as const,
      selected: resource
        ? describeSelected(
            resource,
            selectedType(url, selectedId, type),
            locale,
            primary.locale,
            ownership.get(selectedId) ?? [],
            override,
          )
        : null,
    };
  }

  // The index. Shopify offers no query on `translatableResources` — not by
  // title, not by translation state — so a search goes through the kind's
  // own connection and a state filter is applied here. With a filter on,
  // the read keeps paging until it has a page of matches (or has scanned
  // `SCAN_CAP` resources), and pages on from the last match rather than the
  // last resource read, so nothing is skipped. "All kinds" is an overview:
  // a few of every kind, no paging; a kind is chosen to page through it.
  const listed: Listed[] = [];
  let hasNextPage = false;
  let endCursor: string | null = null;
  let scanned = 0;
  const ownershipByResource = new Map<string, OwnershipRecord[]>();

  const take = async (
    resources: TranslatableResource[],
    resourceType: ResourceType,
  ) => {
    const owned = await listOwnership(
      principal,
      resources.map((r) => r.resourceId),
    );
    for (const [id, records] of owned) ownershipByResource.set(id, records);
    return resources.map((resource) => ({
      id: resource.resourceId,
      title: resourceTitle(resource.fields, resource.resourceId),
      type: resourceType,
      resource,
      states: countStates(
        resource,
        locale,
        owned.get(resource.resourceId) ?? [],
      ),
      depth: 0,
      parentId: null,
      childCount: 0,
    }));
  };
  const matches = (row: Listed) => status === "all" || row.states[status] > 0;

  if (type !== ALL_TYPES && NAVIGATION_TYPES.has(type)) {
    // Navigation is a tree, not two lists: every menu with its items under
    // it. A search or a state filter keeps the matches and the menus above
    // them, so a match is never shown without saying which menu it is in.
    const tree = await readNavigationTree(admin, [locale]);
    const owned = await listOwnership(
      principal,
      tree.nodes.flatMap((node) => (node.resourceId ? [node.resourceId] : [])),
    );
    for (const [id, records] of owned) ownershipByResource.set(id, records);
    const all = tree.nodes.map((node) => {
      const resource = node.resourceId
        ? (tree.resources.get(node.resourceId) ?? null)
        : null;
      return {
        id: node.resourceId ?? node.nodeId,
        title: node.title,
        type: node.kind,
        resource,
        states: resource
          ? countStates(
              resource,
              locale,
              owned.get(node.resourceId ?? "") ?? [],
            )
          : NO_STATES,
        depth: node.depth,
        parentId: node.parentId,
        childCount: node.childCount,
        // The tree's own id, so a child names its parent whatever the
        // translatable resource turned out to be called.
        nodeId: node.nodeId,
      };
    });
    scanned = all.length;
    const needle = q.toLowerCase();
    const hit = (row: (typeof all)[number]) =>
      (needle === "" || row.title.toLowerCase().includes(needle)) &&
      (status === "all" || row.states[status] > 0);
    if (needle === "" && status === "all") {
      listed.push(...all);
    } else {
      const keep = new Set<string>();
      const byNodeId = new Map(all.map((row) => [row.nodeId, row]));
      for (const row of all) {
        if (!hit(row)) continue;
        keep.add(row.nodeId);
        let parent = row.parentId;
        while (parent && !keep.has(parent)) {
          keep.add(parent);
          parent = byNodeId.get(parent)?.parentId ?? null;
        }
      }
      listed.push(...all.filter((row) => keep.has(row.nodeId)));
    }
  } else if (type === ALL_TYPES) {
    const kinds =
      q !== "" ? ALL_RESOURCE_TYPES.filter(isSearchable) : ALL_RESOURCE_TYPES;
    const pages = await Promise.all(
      kinds.map(async (kind) => {
        if (q !== "") {
          const found = await searchResourceIds(admin, kind, q, ALL_PER_KIND);
          const resources = await readTranslatableResourcesByIds(admin, {
            ids: found.map((row) => row.id),
            locales: [locale],
          });
          return { kind, resources };
        }
        const page = await readTranslatableResources(admin, {
          type: kind,
          first: ALL_PER_KIND,
          after: null,
          locales: [locale],
        });
        return { kind, resources: page.resources };
      }),
    );
    for (const page of pages) {
      const rows = await take(page.resources, page.kind);
      scanned += rows.length;
      listed.push(...rows.filter(matches));
    }
  } else if (q !== "" && isSearchable(type)) {
    const found = await searchResourceIds(admin, type, q, PAGE);
    const resources = await readTranslatableResourcesByIds(admin, {
      ids: found.map((row) => row.id),
      locales: [locale],
    });
    const rows = await take(resources, type);
    scanned = rows.length;
    listed.push(...rows.filter(matches));
  } else {
    let cursor = after;
    let more = true;
    while (listed.length < PAGE && more && scanned < SCAN_CAP) {
      const page = await readTranslatableResources(admin, {
        type,
        first: status === "all" ? PAGE : SCAN_PAGE,
        after: cursor,
        locales: [locale],
      });
      const rows = await take(page.resources, type);
      scanned += rows.length;
      more = page.hasNextPage;
      cursor = page.endCursor;
      endCursor = page.endCursor;
      hasNextPage = more;
      for (const [index, row] of rows.entries()) {
        if (!matches(row)) continue;
        listed.push(row);
        if (listed.length === PAGE) {
          // Page on from this match: what follows it is still unread.
          endCursor = page.cursors[index] ?? page.endCursor;
          hasNextPage = index < rows.length - 1 || page.hasNextPage;
          more = false;
          break;
        }
      }
    }
  }

  const ids = listed.map((row) => row.id);
  const needSelected = selectedId !== null && !ids.includes(selectedId);
  const [selectedOwnership, selectedRead, override, cards] = await Promise.all([
    needSelected && selectedId
      ? listOwnership(principal, [selectedId])
      : Promise.resolve(new Map<string, OwnershipRecord[]>()),
    needSelected && selectedId
      ? readTranslatableResourcesByIds(admin, {
          ids: [selectedId],
          locales: [locale],
        })
      : Promise.resolve([] as TranslatableResource[]),
    selectedId
      ? getSourceOverride(principal, selectedId)
      : Promise.resolve(null),
    // The picture and the line under the name, for the kinds that have one.
    readResourceCards(
      admin,
      listed.filter((row) => CARD_TYPES.has(row.type)).map((row) => row.id),
    ),
  ]);
  for (const [id, records] of selectedOwnership)
    ownershipByResource.set(id, records);

  const rows = listed.map((row) => ({
    id: row.id,
    type: row.type,
    title: row.title,
    card: cards.get(row.id) ?? null,
    states: row.states,
    depth: row.depth,
    childCount: row.childCount,
    /** Shopify reports no translatable content for this one. */
    translatable: row.resource !== null,
  }));

  const listedSelected = selectedId
    ? listed.find((row) => row.id === selectedId)
    : undefined;
  const selectedResource = listedSelected?.resource ?? selectedRead[0] ?? null;
  const selected =
    selectedResource && selectedId
      ? describeSelected(
          selectedResource,
          listedSelected?.type ?? selectedType(url, selectedId, type),
          locale,
          primary.locale,
          ownershipByResource.get(selectedId) ?? [],
          override,
        )
      : null;

  return {
    kind: "read" as const,
    primary: { locale: primary.locale, name: primary.name },
    languages: targets.map((l) => ({ locale: l.locale, name: l.name })),
    allLocales: locales.locales.map((l) => ({
      locale: l.locale,
      name: l.name,
      primary: l.primary,
    })),
    locale,
    type,
    status,
    q,
    after,
    searchable: type === ALL_TYPES || isSearchable(type),
    /** Navigation is one tree of menus and their items, read whole. */
    tree: type !== ALL_TYPES && NAVIGATION_TYPES.has(type),
    rows,
    /** How many resources were read to find these. */
    scanned,
    hasNextPage,
    endCursor,
    selected,
    aiConfigured: isConfigured(),
  };
};

/**
 * Changing only which resource is open is the one navigation that must not
 * re-read the index: the dialog fetches the resource itself. Everything else —
 * a filter, a search, a page, and every save — revalidates as usual.
 */
export const shouldRevalidate: ShouldRevalidateFunction = ({
  currentUrl,
  nextUrl,
  formMethod,
  defaultShouldRevalidate,
}) => {
  if (formMethod && formMethod !== "GET") return defaultShouldRevalidate;
  if (currentUrl.pathname !== nextUrl.pathname) return defaultShouldRevalidate;
  const before = new URLSearchParams(currentUrl.search);
  const next = new URLSearchParams(nextUrl.search);
  before.delete("resource");
  next.delete("resource");
  before.sort();
  next.sort();
  if (before.toString() === next.toString()) return false;
  return defaultShouldRevalidate;
};

const saveSchema = z.object({
  resource: z.string().min(1),
  type: z.string(),
  locale: z.string().min(2),
  fields: z.array(
    z.object({
      key: z.string().min(1),
      value: z.string(),
      digest: z.string().min(1),
    }),
  ),
});

type ActionResult = { ok: boolean; message: string };

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<ActionResult> => {
  const { session, admin } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const actor = actorFromSession(session);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "save") {
    let json: unknown;
    try {
      json = JSON.parse(String(formData.get("form") ?? ""));
    } catch {
      return {
        ok: false,
        message: "The form could not be read. Reload the page and try again.",
      };
    }
    const parsed = saveSchema.safeParse(json);
    if (
      !parsed.success ||
      !isLocaleCode(parsed.data.locale) ||
      !isResourceType(parsed.data.type)
    )
      return {
        ok: false,
        message: "The form could not be read. Reload the page and try again.",
      };
    const { resource, type, locale, fields } = parsed.data;

    const writes = fields.filter((field) => field.value.trim() !== "");
    const removals = fields.filter((field) => field.value.trim() === "");

    // A person's translation is the strongest signal memory gets: it is
    // reused for the same string and shown to the model for related ones.
    const [locales, sourceRead, override] = await Promise.all([
      listShopLocales(admin),
      readTranslatableResourcesByIds(admin, { ids: [resource], locales: [] }),
      getSourceOverride(principal, resource),
    ]);
    const primaryLocale =
      locales.kind === "read"
        ? (locales.locales.find((l) => l.primary)?.locale ?? null)
        : null;
    const sourceLocale = override?.sourceLocale ?? primaryLocale;
    const sourceFields = new Map(
      (sourceRead[0]?.fields ?? []).map((field) => [field.key, field]),
    );

    if (writes.length > 0) {
      const written = await registerTranslations(
        admin,
        resource,
        writes.map((field) => ({
          key: field.key,
          locale,
          value: field.value,
          digest: field.digest,
        })),
      );
      if (written.kind === "rejected")
        return {
          ok: false,
          message: `Shopify refused the translation: ${written.messages.join("; ")}`,
        };
      await recordOwnership(
        principal,
        writes.map((field) => ({
          resourceId: resource,
          resourceType: type,
          key: field.key,
          locale,
          owner: "manual" as const,
          valueHash: hashValue(field.value),
          sourceDigest: field.digest,
          syncId: null,
          writtenBy: actor,
        })),
        new Date(),
      );
      if (sourceLocale && sourceLocale !== locale) {
        const pairs = writes.flatMap((field) => {
          const source = sourceFields.get(field.key);
          if (!source || !isMemorable(source)) return [];
          return [
            {
              sourceLocale,
              targetLocale: locale,
              sourceKey: memoryKey(source.value),
              sourceText: source.value.trim(),
              targetText: field.value.trim(),
              resourceType: type,
              resourceId: resource,
            },
          ];
        });
        await rememberTranslations(principal, pairs, "manual", new Date());
      }
    }
    if (removals.length > 0) {
      const removed = await removeTranslations(
        admin,
        resource,
        [locale],
        removals.map((field) => field.key),
      );
      if (removed.kind === "rejected")
        return {
          ok: false,
          message: `Shopify refused: ${removed.messages.join("; ")}`,
        };
      await forgetOwnership(
        principal,
        resource,
        locale,
        removals.map((field) => field.key),
      );
      if (sourceLocale)
        await forgetMemory(principal, {
          sourceLocale,
          targetLocale: locale,
          sourceKeys: removals.flatMap((field) => {
            const source = sourceFields.get(field.key);
            return source ? [memoryKey(source.value)] : [];
          }),
        });
    }
    await appendEvent(principal, {
      entityType: "translation",
      entityId: resource,
      event: "translation.edited",
      detail: {
        locale,
        written: writes.length,
        removed: removals.length,
        by: actor,
      },
    });
    return {
      ok: true,
      message: `Saved to Shopify: ${writes.length} ${writes.length === 1 ? "field" : "fields"}${removals.length > 0 ? `, ${removals.length} cleared` : ""}.`,
    };
  }

  if (intent === "translate") {
    const resource = String(formData.get("resource") ?? "");
    const locale = String(formData.get("locale") ?? "");
    const typeParam = String(formData.get("type") ?? "");
    const mode = String(formData.get("mode") ?? "missing");
    if (!resource || !isLocaleCode(locale) || !isResourceType(typeParam))
      return { ok: false, message: "Unknown resource." };
    if (mode !== "missing" && mode !== "missing_outdated" && mode !== "force")
      return { ok: false, message: "Unknown action." };
    if (!isConfigured())
      return {
        ok: false,
        message: "AI translation is not configured on this server.",
      };
    const locales = await listShopLocales(admin);
    const primary =
      locales.kind === "read"
        ? locales.locales.find((l) => l.primary)
        : undefined;
    if (!primary)
      return {
        ok: false,
        message: "Languages could not be read from Shopify.",
      };

    const result = await translateResourceNow(principal, admin, {
      resourceId: resource,
      resourceType: typeParam,
      primaryLocale: primary.locale,
      targetLocales: [locale],
      mode,
      requestedBy: actor,
    });
    if (!result.found)
      return {
        ok: false,
        message: "The resource could not be read from Shopify.",
      };
    const { translated, copied, skipped, failed } = result.outcome;
    if (failed > 0)
      return {
        ok: false,
        message:
          result.outcome.items.find((item) => item.error)?.error ??
          "The translation failed.",
      };
    if (translated + copied === 0)
      return {
        ok: true,
        message: `Nothing to translate: ${skipped} fields already have a translation or are protected.`,
      };
    return {
      ok: true,
      message: `Translated ${translated} ${translated === 1 ? "field" : "fields"}${copied > 0 ? `, copied ${copied}` : ""}${skipped > 0 ? `, left ${skipped} as they were` : ""}.`,
    };
  }

  if (intent === "set-source") {
    const resource = String(formData.get("resource") ?? "");
    const typeParam = String(formData.get("type") ?? "");
    const source = String(formData.get("source") ?? "");
    if (!resource || !isResourceType(typeParam))
      return { ok: false, message: "Unknown resource." };
    if (source !== "" && !isLocaleCode(source))
      return { ok: false, message: "Unknown language." };
    await setSourceOverride(principal, {
      resourceId: resource,
      resourceType: typeParam,
      sourceLocale: source === "" ? null : source,
      setBy: actor,
    });
    await appendEvent(principal, {
      entityType: "translation",
      entityId: resource,
      event: "translation.source_changed",
      detail: { source: source || null, by: actor },
    });
    return {
      ok: true,
      message:
        source === ""
          ? "Source language: the store default."
          : `Source language set to ${source}.`,
    };
  }

  if (intent === "detect-source") {
    const resource = String(formData.get("resource") ?? "");
    const typeParam = String(formData.get("type") ?? "");
    if (!resource || !isResourceType(typeParam))
      return { ok: false, message: "Unknown resource." };
    if (!isConfigured())
      return {
        ok: false,
        message: "AI translation is not configured on this server.",
      };
    const [read, locales] = await Promise.all([
      readTranslatableResourcesByIds(admin, { ids: [resource], locales: [] }),
      listShopLocales(admin),
    ]);
    const primary =
      locales.kind === "read"
        ? locales.locales.find((l) => l.primary)
        : undefined;
    const found = read[0];
    if (!found || !primary)
      return {
        ok: false,
        message: "The resource could not be read from Shopify.",
      };
    const sample = detectionSample(found.fields.filter(isTranslatableField));
    if (sample.trim() === "")
      return {
        ok: false,
        message: "There is no text to detect a language from.",
      };
    // What sits next to the resource helps with a short label; the store's
    // own languages are what the answer is most likely among.
    const contexts = new ContextSource(admin);
    await contexts.prime([{ resourceId: resource, type: typeParam }]);
    const neighbourText = await contexts.neighbourText(
      resource,
      typeParam,
      resourceTitle(found.fields, resource),
    );
    const detected = await detectLanguage(principal, sample, {
      resourceId: resource,
      resourceType: typeParam,
      storeLocale: primary.locale,
      candidateLocales:
        locales.kind === "read" ? locales.locales.map((l) => l.locale) : [],
      neighbourText,
    });
    if (detected.kind === "failed")
      return { ok: false, message: detected.message };
    await recordDetectedSource(principal, {
      resourceId: resource,
      resourceType: typeParam,
      detectedLocale: detected.locale,
      detectedConfidence: detected.confidence,
      primaryLocale: primary.locale,
    });
    const confidence = describeConfidence(detected.confidence);
    return {
      ok: true,
      message: detected.shortSample
        ? `This may be ${localeLabel(detected.locale)} (${confidence}). Nothing changed; set it as the source only if you are sure.`
        : `This looks like ${localeLabel(detected.locale)} (${confidence}). Nothing changed; set it as the source if that is right.`,
    };
  }

  return { ok: false, message: "Unknown action." };
};

type LoaderData = Awaited<ReturnType<typeof loader>>;
type ReadData = Extract<LoaderData, { kind: "read" }>;
type Selected = NonNullable<ReadData["selected"]>;
type Row = ReadData["rows"][number];

export default function Editor() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data;

  useEffect(() => {
    if (!result?.ok) return;
    if (typeof shopify !== "undefined") shopify.toast.show(result.message);
  }, [result]);

  if (data.kind === "unavailable") {
    return (
      <s-page heading="Editor" inlineSize="large">
        <s-link slot="breadcrumb-actions" href={TRANSLATION_ROUTES.languages}>
          Translations
        </s-link>
        <s-stack direction="block" gap="large">
          <TranslationsNav current="editor" />
          <s-banner
            tone="warning"
            heading="Translations could not be read from Shopify"
          >
            <s-paragraph>{data.reason}</s-paragraph>
          </s-banner>
        </s-stack>
      </s-page>
    );
  }
  if (data.kind === "no-languages") {
    return (
      <s-page heading="Editor" inlineSize="large">
        <s-link slot="breadcrumb-actions" href={TRANSLATION_ROUTES.languages}>
          Translations
        </s-link>
        <s-stack direction="block" gap="large">
          <TranslationsNav current="editor" />
          <s-section heading="Nothing to translate into yet">
            <s-stack direction="block" gap="base">
              <s-text>
                {`${data.primary.name} is the store's only language. Add a language to start translating.`}
              </s-text>
              <s-stack direction="inline">
                <s-button variant="primary" href={TRANSLATION_ROUTES.add}>
                  Add language
                </s-button>
              </s-stack>
            </s-stack>
          </s-section>
        </s-stack>
      </s-page>
    );
  }
  if (data.kind === "resource") {
    // Only ever answered to the dialog's own fetch, never rendered as a page.
    return null;
  }
  return (
    <Workspace
      key={`${data.locale}|${data.type}|${data.status}|${data.q}|${data.after ?? ""}`}
      data={data}
      fetcher={fetcher}
      result={result ?? null}
    />
  );
}

/** The chosen resource as the dialog knows it: what it shows, or why not. */
type Pane =
  | { kind: "none" }
  | { kind: "loading"; id: string; title: string }
  | { kind: "missing"; id: string }
  | { kind: "ready"; id: string; selected: Selected };

/**
 * The index and the dialog over it. The index is the page: language, search
 * and filters above a table of resources. Choosing a row opens the resource
 * in the dialog and puts it in the address, so a reload or a bookmark opens
 * the same one; closing the dialog takes it out of the address but keeps
 * what was typed, so an accidental close loses nothing.
 */
function Workspace({
  data,
  fetcher,
  result,
}: {
  data: ReadData;
  fetcher: ReturnType<typeof useFetcher<typeof action>>;
  result: ActionResult | null;
}) {
  const navigate = useNavigate();
  const resourceFetcher = useFetcher<typeof loader>();
  const busy = fetcher.state !== "idle";

  // The page the index is on travels with every address built here, so
  // choosing a resource on a later page does not fall back to the first.
  const list: ListParams = {
    locale: data.locale,
    type: data.type,
    status: data.status,
    q: data.q,
    after: data.after,
  };

  const [pane, setPane] = useState<Pane>(() =>
    data.selected
      ? { kind: "ready", id: data.selected.id, selected: data.selected }
      : { kind: "none" },
  );
  const [open, setOpen] = useState(pane.kind !== "none");
  const selectedId = pane.kind === "none" ? null : pane.id;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

  // A save or a translation revalidates the loader, which then carries the
  // open resource fresh. The dialog takes it only when it is still the one open.
  useEffect(() => {
    const fresh = data.selected;
    if (fresh && fresh.id === selectedRef.current)
      setPane({ kind: "ready", id: fresh.id, selected: fresh });
  }, [data]);

  useEffect(() => {
    const answer = resourceFetcher.data;
    if (!answer || answer.kind !== "resource") return;
    const wanted = selectedRef.current;
    if (wanted === null) return;
    if (answer.selected && answer.selected.id === wanted)
      setPane({ kind: "ready", id: wanted, selected: answer.selected });
    else if (!answer.selected)
      setPane((now) =>
        now.kind === "loading" && now.id === wanted
          ? { kind: "missing", id: wanted }
          : now,
      );
  }, [resourceFetcher.data]);

  const choose = (row: Row) => {
    setOpen(true);
    if (row.id === selectedId) return;
    setPane({ kind: "loading", id: row.id, title: row.title });
    void resourceFetcher.load(
      editorUrl({
        ...list,
        resource: row.id,
        resourceType: row.type,
        part: "resource",
      }),
    );
    void navigate(
      editorUrl({ ...list, resource: row.id, resourceType: row.type }),
      { replace: true },
    );
  };

  const close = () => {
    setOpen(false);
    if (selectedId !== null) void navigate(editorUrl(list), { replace: true });
  };

  const index = data.rows.findIndex((row) => row.id === selectedId);
  const previous = index > 0 ? (data.rows[index - 1] ?? null) : null;
  const next =
    index >= 0 && index < data.rows.length - 1
      ? (data.rows[index + 1] ?? null)
      : null;

  // A new filter or search starts from the first page; only "Next page"
  // itself carries a cursor forward.
  const openList = (patch: Partial<ListParams>) =>
    void navigate(editorUrl({ ...list, after: null, ...patch }));

  return (
    <s-page heading="Editor" inlineSize="large">
      <s-link slot="breadcrumb-actions" href={TRANSLATION_ROUTES.languages}>
        Translations
      </s-link>

      <s-stack direction="block" gap="base">
        <TranslationsNav current="editor" />

        {result && !result.ok ? (
          <s-banner tone="critical" heading="That did not work">
            <s-paragraph>{result.message}</s-paragraph>
          </s-banner>
        ) : null}

        <ResourceIndex
          data={data}
          selectedId={open ? selectedId : null}
          busy={busy}
          onChoose={choose}
          onOpen={openList}
          onBack={() => void navigate(-1)}
        />
      </s-stack>

      <ResourceModal
        data={data}
        pane={pane}
        open={open}
        fetcher={fetcher}
        busy={busy}
        previous={previous}
        next={next}
        onChoose={choose}
        onClose={close}
      />
    </s-page>
  );
}

/* -------------------------------------------------------------------------- */
/* The index                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A page of resources as the admin's own product index draws them: the
 * search and the filters in the bar above the columns, then a row per
 * resource — picture, name, one line under it — with what its translation
 * needs at the end.
 */
function ResourceIndex({
  data,
  selectedId,
  busy,
  onChoose,
  onOpen,
  onBack,
}: {
  data: ReadData;
  selectedId: string | null;
  busy: boolean;
  onChoose: (row: Row) => void;
  onOpen: (patch: Partial<ListParams>) => void;
  /** The page before this one: Shopify pages forward only, so this is history. */
  onBack: () => void;
}) {
  const [q, setQ] = useState(data.q);
  useResetWhenSaved(
    data.q,
    useCallback(() => setQ(data.q), [data.q]),
  );
  const kind: ResourceType | null = data.type === ALL_TYPES ? null : data.type;
  const all = kind === null;
  const tree = data.tree;
  const kindLabel = tree
    ? "Menu"
    : kind
      ? RESOURCE_TYPE_LABEL[kind]
      : "Resource";
  const noun = tree ? "menu or link" : kindLabel.toLowerCase();
  const nouns = tree ? "menus and links" : `${noun}s`;
  const filtered = data.status !== "all";
  const group = kind ? groupForType(kind) : null;
  // The tree is both of navigation's kinds at once, so there is no kind to pick.
  const kinds = group && !tree ? CONTENT_GROUPS[group].types : [];

  /*
   * Which branches are open. The set holds what has been toggled away from
   * the default, and the default is open while a search or a filter is on —
   * a match must never be hidden inside a closed menu. A change of filter
   * remounts this component (the workspace is keyed on it), so the default
   * is read once.
   */
  const [allOpen, setAllOpen] = useState(data.q !== "" || filtered);
  const [toggled, setToggled] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const isOpen = (id: string) => (allOpen ? !toggled.has(id) : toggled.has(id));
  const toggle = (id: string) =>
    setToggled((now) => {
      const next = new Set(now);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const setAll = (open: boolean) => {
    setAllOpen(open);
    setToggled(new Set<string>());
  };

  /*
   * The rows to draw: everything when this is a flat list, and otherwise
   * the tree with closed branches left out. The rows arrive in tree order,
   * so a row is inside a closed branch when the last branch closed is
   * shallower than it is.
   */
  const visible = !tree
    ? data.rows
    : data.rows.filter(
        (() => {
          let closedAt: number | null = null;
          return (row: Row) => {
            if (closedAt !== null && row.depth > closedAt) return false;
            closedAt = null;
            if (row.childCount > 0 && !isOpen(row.id)) closedAt = row.depth;
            return true;
          };
        })(),
      );
  const menus = tree ? data.rows.filter((row) => row.depth === 0).length : 0;
  const links = tree ? data.rows.length - menus : 0;

  return (
    <s-section accessibilityLabel={all ? "All content" : `${kindLabel}s`}>
      <s-stack direction="block" gap="small-300">
        {/*
         * The kinds as a row of tabs, the way the admin's own index pages
         * switch views: everything at once, or one group of content. A group
         * with several kinds in it — products, their options and their
         * option values — names the kind in the bar below.
         */}
        <s-stack direction="inline" gap="small-400" alignItems="center">
          <KindTab
            label="All"
            current={all}
            disabled={busy}
            onClick={() => onOpen({ type: ALL_TYPES })}
          />
          {ALL_CONTENT_GROUPS.map((candidate) => (
            <KindTab
              key={candidate}
              label={CONTENT_GROUPS[candidate].label}
              current={group === candidate}
              disabled={busy}
              onClick={() =>
                onOpen({
                  type: CONTENT_GROUPS[candidate].types[0] ?? "PRODUCT",
                })
              }
            />
          ))}
        </s-stack>

        <s-table variant="auto" {...(busy ? { loading: true } : {})}>
          {/*
           * The bar above the columns: which language, then the search across
           * the width, then the two filters — the order the admin's own index
           * bars read in. A search field is what takes the room.
           */}
          <s-grid
            slot="filters"
            gridTemplateColumns={
              kinds.length > 1 || tree
                ? "@container (inline-size <= 760px) 1fr, 'minmax(180px, 240px) minmax(0, 1fr) minmax(150px, 200px) minmax(150px, 200px)'"
                : "@container (inline-size <= 760px) 1fr, 'minmax(180px, 240px) minmax(0, 1fr) minmax(150px, 200px)'"
            }
            gap="small-300"
            alignItems="center"
          >
            <Dropdown
              name="locale"
              label="Translate into"
              hideLabel
              value={data.locale}
              options={data.languages.map((l) => ({
                value: l.locale,
                label: localeLabel(l.locale, l.name),
              }))}
              onChange={(next) => onOpen({ locale: next })}
              disabled={busy}
            />
            <s-search-field
              label={`Search ${nouns} by title`}
              labelAccessibilityVisibility="exclusive"
              placeholder={
                data.searchable
                  ? `Search ${nouns}`
                  : `${kindLabel}s cannot be searched`
              }
              value={q}
              onInput={(event) => setQ(event.currentTarget.value)}
              onChange={(event) => {
                setQ(event.currentTarget.value);
                onOpen({ q: event.currentTarget.value });
              }}
              {...(busy || !data.searchable ? { disabled: true } : {})}
            />
            {kinds.length > 1 ? (
              <Dropdown
                name="type"
                label="Kind"
                hideLabel
                value={data.type}
                options={kinds.map((type) => ({
                  value: type,
                  label: RESOURCE_TYPE_LABEL[type],
                }))}
                onChange={(next) => {
                  if (isResourceType(next)) onOpen({ type: next });
                }}
                disabled={busy}
              />
            ) : tree ? (
              <s-button
                variant="secondary"
                icon={allOpen ? "minus-circle" : "plus-circle"}
                onClick={() => setAll(!allOpen)}
              >
                {allOpen ? "Collapse all" : "Expand all"}
              </s-button>
            ) : null}
            <Dropdown
              name="status"
              label="Show"
              hideLabel
              value={data.status}
              options={STATUS_FILTERS.map((status) => ({
                value: status,
                label: STATUS_FILTER_LABEL[status],
              }))}
              onChange={(next) => {
                if (isStatusFilter(next)) onOpen({ status: next });
              }}
              disabled={busy}
            />
          </s-grid>

          <s-table-header-row>
            <s-table-header listSlot="primary">{kindLabel}</s-table-header>
            <s-table-header listSlot="secondary">
              {localeLabel(data.locale)}
            </s-table-header>
            <s-table-header listSlot="inline">Fields</s-table-header>
          </s-table-header-row>

          <s-table-body>
            {visible.map((row) => (
              <IndexRow
                key={row.id}
                row={row}
                showKind={all}
                tree={tree}
                open={row.childCount > 0 ? isOpen(row.id) : false}
                current={row.id === selectedId}
                onToggle={() => toggle(row.id)}
                onChoose={() => onChoose(row)}
              />
            ))}
          </s-table-body>
        </s-table>

        {data.rows.length === 0 ? (
          <s-box paddingBlock="large-100">
            <s-stack direction="block" gap="small-300" alignItems="center">
              <s-text color="subdued">
                {filtered && data.scanned > 0
                  ? `None of the ${data.scanned.toLocaleString("en")} ${nouns} read are "${STATUS_FILTER_LABEL[data.status].toLowerCase()}".${data.hasNextPage ? " There are more to read." : ""}`
                  : data.q
                    ? `No ${noun} matches "${data.q}".`
                    : `No ${nouns} here.`}
              </s-text>
              <s-stack direction="inline" gap="small-300">
                {filtered && data.hasNextPage ? (
                  <s-button
                    variant="secondary"
                    onClick={() => onOpen({ after: data.endCursor })}
                    {...(busy ? { disabled: true } : {})}
                  >
                    Keep looking
                  </s-button>
                ) : null}
                {filtered || data.q ? (
                  <s-button
                    variant="tertiary"
                    onClick={() => {
                      setQ("");
                      onOpen({ status: "all", q: "" });
                    }}
                  >
                    Clear filters
                  </s-button>
                ) : null}
              </s-stack>
            </s-stack>
          </s-box>
        ) : (
          /*
           * The way through the list, said in words: what this page is, how
           * many were read to find it, and the two pages beside it. Shopify
           * pages forward only, so "Previous" is the browser's own history.
           */
          <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
            <s-text color="subdued">
              {tree
                ? `${menus} ${menus === 1 ? "menu" : "menus"} and ${links} ${links === 1 ? "link" : "links"}${data.q || filtered ? " match" : ""}, the whole navigation tree.`
                : all
                  ? `${data.rows.length} ${nouns}: up to ${ALL_PER_KIND} of each kind. Choose a kind to see all of it.`
                  : filtered
                    ? `${data.rows.length} ${data.rows.length === 1 ? noun : nouns} ${STATUS_FILTER_LABEL[data.status].toLowerCase()} among the ${data.scanned.toLocaleString("en")} read${data.hasNextPage ? "; more to read on the next page" : ""}.`
                    : `${data.rows.length} ${data.rows.length === 1 ? noun : nouns} on this page.`}
            </s-text>
            {!all && !tree && (data.hasNextPage || data.after) ? (
              <s-stack direction="inline" gap="small-300">
                <s-button
                  variant="secondary"
                  icon="chevron-left"
                  onClick={onBack}
                  {...(data.after && !busy ? {} : { disabled: true })}
                >
                  Previous page
                </s-button>
                <s-button
                  variant="secondary"
                  icon="chevron-right"
                  onClick={() => onOpen({ after: data.endCursor })}
                  {...(data.hasNextPage && !busy ? {} : { disabled: true })}
                >
                  Next page
                </s-button>
              </s-stack>
            ) : null}
          </s-grid>
        )}
      </s-stack>
    </s-section>
  );
}

/** One of the index's tabs: the current one stated, the others clickable. */
function KindTab({
  label,
  current,
  disabled,
  onClick,
}: {
  label: string;
  current: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <s-button
      variant={current ? "secondary" : "tertiary"}
      onClick={onClick}
      {...(current ? { accessibilityLabel: `${label}, shown` } : {})}
      {...(disabled ? { disabled: true } : {})}
    >
      {label}
    </s-button>
  );
}

function IndexRow({
  row,
  showKind,
  tree,
  open,
  current,
  onToggle,
  onChoose,
}: {
  row: Row;
  showKind: boolean;
  tree: boolean;
  open: boolean;
  current: boolean;
  onToggle: () => void;
  onChoose: () => void;
}) {
  const card = row.card;
  const hasPicture = card !== null;
  const subtitle = [
    showKind ? RESOURCE_TYPE_LABEL[row.type] : null,
    tree && row.childCount > 0
      ? `${row.childCount} ${row.childCount === 1 ? "item" : "items"}`
      : null,
    card?.status === "DRAFT"
      ? "Draft"
      : card?.status === "ARCHIVED"
        ? "Archived"
        : null,
    card?.subtitle ?? null,
  ]
    .filter(Boolean)
    .join(" · ");
  const rowId = `open-${row.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

  return (
    <s-table-row {...(row.translatable ? { clickDelegate: rowId } : {})}>
      <s-table-cell>
        {/*
         * `s-image` in a fixed box rather than `s-thumbnail`, for the reason
         * the products page gives: a framed tile reads as a missing input
         * beside a name rather than as a picture of the thing.
         */}
        <s-grid
          gridTemplateColumns={
            tree
              ? hasPicture
                ? "auto 40px minmax(0, 1fr)"
                : "auto minmax(0, 1fr)"
              : hasPicture
                ? "40px minmax(0, 1fr)"
                : "1fr"
          }
          gap="small-300"
          alignItems="center"
        >
          {/*
           * The branch: an indent a step deep per level, and the twist that
           * opens it. A leaf keeps the same indent so its title lines up
           * with its siblings' rather than with their chevrons.
           */}
          {tree ? (
            <s-stack direction="inline" gap="none" alignItems="center">
              <s-box inlineSize={`${row.depth * 20}px`} />
              {row.childCount > 0 ? (
                <s-button
                  variant="tertiary"
                  icon={open ? "chevron-down" : "chevron-right"}
                  accessibilityLabel={`${open ? "Collapse" : "Expand"} ${row.title}`}
                  onClick={onToggle}
                />
              ) : (
                <s-box inlineSize="28px" />
              )}
            </s-stack>
          ) : null}
          {hasPicture ? (
            <s-box
              inlineSize="40px"
              blockSize="40px"
              borderRadius="base"
              background="subdued"
              overflow="hidden"
            >
              {card?.imageUrl ? (
                <s-image
                  src={card.imageUrl}
                  alt=""
                  inlineSize="fill"
                  objectFit="cover"
                  loading="lazy"
                />
              ) : null}
            </s-box>
          ) : null}
          <s-stack direction="block" gap="none">
            {row.translatable ? (
              <s-link id={rowId} onClick={onChoose}>
                <s-text type={current ? "strong" : "generic"}>
                  {row.title}
                </s-text>
              </s-link>
            ) : (
              <s-text color="subdued">{row.title}</s-text>
            )}
            {subtitle ? (
              <s-paragraph lineClamp={1} color="subdued">
                {subtitle}
              </s-paragraph>
            ) : null}
          </s-stack>
        </s-grid>
      </s-table-cell>
      <s-table-cell>
        {/*
         * Colour marks what needs a person: a count of missing or outdated
         * fields, and a calm word for a resource that is done.
         */}
        {!row.translatable ? (
          <s-text color="subdued">Nothing to translate</s-text>
        ) : row.states.missing > 0 ? (
          <s-badge tone="warning">{`${row.states.missing} missing`}</s-badge>
        ) : row.states.outdated > 0 ? (
          <s-badge tone="critical">{`${row.states.outdated} outdated`}</s-badge>
        ) : (
          <s-text color="subdued">Translated</s-text>
        )}
      </s-table-cell>
      <s-table-cell>
        <s-text color="subdued">{summariseStates(row.states)}</s-text>
      </s-table-cell>
    </s-table-row>
  );
}

function summariseStates(states: StateCounts): string {
  const parts: string[] = [];
  if (states.missing > 0) parts.push(`${states.missing} missing`);
  if (states.outdated > 0) parts.push(`${states.outdated} outdated`);
  if (states.manual > 0) parts.push(`${states.manual} by a person`);
  if (states.ai > 0) parts.push(`${states.ai} by AI`);
  if (states.existing > 0) parts.push(`${states.existing} existing`);
  return parts.length === 0 ? "no text fields" : parts.join(", ");
}

/* -------------------------------------------------------------------------- */
/* The dialog                                                                 */
/* -------------------------------------------------------------------------- */

const MODAL_ID = "translation-editor-resource";
type Overlay = { showOverlay?: () => void; hideOverlay?: () => void };

/**
 * One resource in a dialog over the index: every field's source beside its
 * translation, the AI's buttons, and Save in the footer. What is typed is
 * kept per resource while the page lives, so closing and reopening finds
 * it; moving to the previous or next resource is closed while there are
 * unsaved edits, so nothing is walked away from by accident.
 */
function ResourceModal({
  data,
  pane,
  open,
  fetcher,
  busy,
  previous,
  next,
  onChoose,
  onClose,
}: {
  data: ReadData;
  pane: Pane;
  open: boolean;
  fetcher: ReturnType<typeof useFetcher<typeof action>>;
  busy: boolean;
  previous: Row | null;
  next: Row | null;
  onChoose: (row: Row) => void;
  onClose: () => void;
}) {
  const overlay = useRef<Overlay | null>(null);
  const shown = useRef(false);
  const [full, setFull] = useState<string | null>(null);

  useEffect(() => {
    if (open && !shown.current) {
      shown.current = true;
      overlay.current?.showOverlay?.();
    } else if (!open && shown.current) {
      shown.current = false;
      overlay.current?.hideOverlay?.();
    }
  }, [open]);

  const selected = pane.kind === "ready" ? pane.selected : null;
  const openId = pane.kind === "none" ? null : pane.id;
  useEffect(() => {
    setFull(null);
  }, [openId]);
  const initial = Object.fromEntries(
    (selected?.fields ?? []).map((f) => [f.key, f.translation]),
  );
  const [values, setValues] = useState<Record<string, string>>(initial);
  const savedKey = `${selected?.id ?? ""}|${data.locale}|${JSON.stringify(initial)}`;
  useResetWhenSaved(
    savedKey,
    useCallback(() => setValues(initial), [initial]),
  );
  const changed = selected
    ? selected.fields.filter((f) => (values[f.key] ?? "") !== f.translation)
    : [];
  const dirty = changed.length > 0;

  const save = () => {
    if (!selected) return;
    fetcher.submit(
      {
        intent: "save",
        form: JSON.stringify({
          resource: selected.id,
          type: selected.type,
          locale: data.locale,
          fields: changed.map((f) => ({
            key: f.key,
            value: values[f.key] ?? "",
            digest: f.digest,
          })),
        }),
      },
      { method: "post" },
    );
  };

  const heading =
    pane.kind === "ready"
      ? pane.selected.title
      : pane.kind === "loading"
        ? pane.title
        : pane.kind === "missing"
          ? "Not found"
          : "Translation";

  return (
    <s-modal
      id={MODAL_ID}
      heading={full ? `${heading} · one field` : heading}
      size="large"
      ref={(element) => {
        overlay.current = (element as Overlay | null) ?? null;
      }}
      onAfterHide={() => {
        if (shown.current) {
          shown.current = false;
          setFull(null);
          onClose();
        }
      }}
    >
      <s-query-container containerName="workspace">
        {pane.kind === "loading" ? (
          <s-stack direction="block" gap="base">
            <s-text color="subdued">
              {`${localeLabel(data.primary.locale, data.primary.name)} → ${localeLabel(data.locale)}`}
            </s-text>
            <s-box paddingBlock="large">
              <s-stack direction="inline" gap="small-300" alignItems="center">
                <s-spinner
                  size="base"
                  accessibilityLabel="Reading from Shopify"
                />
                <s-text color="subdued">Reading from Shopify</s-text>
              </s-stack>
            </s-box>
          </s-stack>
        ) : pane.kind === "missing" ? (
          <s-text color="subdued">
            {`Shopify no longer has ${describeResourceId(pane.id)}.`}
          </s-text>
        ) : pane.kind === "ready" ? (
          <ResourceEditor
            key={`${pane.id}|${data.locale}`}
            data={data}
            selected={pane.selected}
            fetcher={fetcher}
            busy={busy}
            dirty={dirty}
            values={values}
            onChange={(key, value) =>
              setValues((now) => ({ ...now, [key]: value }))
            }
            previous={previous}
            next={next}
            onChoose={onChoose}
            full={full}
            onFull={setFull}
          />
        ) : null}
      </s-query-container>

      {dirty ? (
        <s-button
          slot="secondary-actions"
          onClick={() => setValues(initial)}
          {...(busy ? { disabled: true } : {})}
        >
          Discard changes
        </s-button>
      ) : (
        <s-button
          slot="secondary-actions"
          command="--hide"
          commandFor={MODAL_ID}
        >
          Close
        </s-button>
      )}
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={save}
        {...(dirty && !busy ? {} : { disabled: true })}
        {...(busy ? { loading: true } : {})}
      >
        Save to Shopify
      </s-button>
    </s-modal>
  );
}

function ResourceEditor({
  data,
  selected,
  fetcher,
  busy,
  dirty,
  values,
  onChange,
  previous,
  next,
  onChoose,
  full,
  onFull,
}: {
  data: ReadData;
  selected: Selected;
  fetcher: ReturnType<typeof useFetcher<typeof action>>;
  busy: boolean;
  dirty: boolean;
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  previous: Row | null;
  next: Row | null;
  onChoose: (row: Row) => void;
  /** The field that has the dialog to itself, if any. */
  full: string | null;
  onFull: (key: string | null) => void;
}) {
  const translate = (mode: "missing_outdated" | "force") =>
    fetcher.submit(
      {
        intent: "translate",
        resource: selected.id,
        type: selected.type,
        locale: data.locale,
        mode,
      },
      { method: "post" },
    );

  const sourceOptions = [
    {
      value: "",
      label: `${localeLabel(data.primary.locale, data.primary.name)} — store default`,
    },
    ...data.allLocales
      .filter((l) => !l.primary)
      .map((l) => ({ value: l.locale, label: localeLabel(l.locale, l.name) })),
  ];

  const canTranslate =
    !busy &&
    !dirty &&
    data.aiConfigured &&
    selected.sourceLocale !== data.locale;
  const needsWork = selected.fields.filter(
    (f) => f.prose && (f.state === "missing" || f.state === "outdated"),
  ).length;
  const canMove = !busy && !dirty;
  const fullField = full
    ? (selected.fields.find((field) => field.key === full) ?? null)
    : null;

  /*
   * The full editor: one field with the whole dialog, everything else out
   * of the way. The header becomes the way back and the field's own name,
   * and the footer's Save is the dialog's, so a field is never saved from
   * somewhere a person cannot see it.
   */
  if (fullField)
    return (
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="small-300" alignItems="center">
          <s-button
            variant="tertiary"
            icon="arrow-left"
            onClick={() => onFull(null)}
          >
            All fields
          </s-button>
          <s-text type="strong">{fullField.label}</s-text>
          <FieldStateBadge state={fullField.state} />
        </s-stack>
        <FieldRow
          key={fullField.key}
          field={fullField}
          sourceLocale={selected.sourceLocale}
          targetLocale={data.locale}
          value={values[fullField.key] ?? ""}
          busy={busy}
          full
          onChange={(value) => onChange(fullField.key, value)}
          onFull={(next) => onFull(next ? fullField.key : null)}
        />
      </s-stack>
    );

  return (
    <s-stack direction="block" gap="large">
      {/* What is open, where it goes, the way through the list, and the AI. */}
      <s-grid
        gridTemplateColumns="@container workspace (inline-size <= 760px) 1fr, 'minmax(0, 1fr) auto'"
        gap="base"
        alignItems="center"
      >
        <s-text color="subdued">
          {`${RESOURCE_TYPE_LABEL[selected.type]} · ${describeResourceId(selected.id)} · ${localeLabel(selected.sourceLocale)} → ${localeLabel(data.locale)}`}
        </s-text>
        <s-stack direction="inline" gap="small-300" alignItems="center">
          <s-button
            variant="tertiary"
            icon="chevron-left"
            accessibilityLabel={
              previous ? `Previous: ${previous.title}` : "Previous"
            }
            onClick={() => previous && onChoose(previous)}
            {...(previous && canMove ? {} : { disabled: true })}
          >
            Previous
          </s-button>
          <s-button
            variant="tertiary"
            icon="chevron-right"
            accessibilityLabel={next ? `Next: ${next.title}` : "Next"}
            onClick={() => next && onChoose(next)}
            {...(next && canMove ? {} : { disabled: true })}
          >
            Next
          </s-button>
          <s-button
            variant="secondary"
            onClick={() => translate("force")}
            {...(canTranslate ? {} : { disabled: true })}
          >
            Retranslate AI fields
          </s-button>
          <s-button
            variant="secondary"
            onClick={() => translate("missing_outdated")}
            {...(canTranslate && needsWork > 0 ? {} : { disabled: true })}
          >
            {needsWork > 0
              ? `Translate ${needsWork} with AI`
              : "Translate with AI"}
          </s-button>
        </s-stack>
      </s-grid>

      {dirty ? (
        <s-text color="subdued">
          Unsaved changes. Save or discard them before moving on or asking the
          AI.
        </s-text>
      ) : null}

      <s-divider />

      <SourceRow
        data={data}
        selected={selected}
        fetcher={fetcher}
        busy={busy}
        options={sourceOptions}
      />

      {selected.fields.length === 0 ? (
        <s-text color="subdued">
          Shopify reports no translatable fields on this resource.
        </s-text>
      ) : null}

      {selected.fields.map((field) => (
        <FieldRow
          key={field.key}
          field={field}
          sourceLocale={selected.sourceLocale}
          targetLocale={data.locale}
          value={values[field.key] ?? ""}
          busy={busy}
          full={false}
          onChange={(value) => onChange(field.key, value)}
          onFull={(next) => onFull(next ? field.key : null)}
        />
      ))}

      <s-text color="subdued">
        Fields you edit here are yours: the AI leaves them alone on every later
        run, unless the language allows overwriting everything.
      </s-text>
    </s-stack>
  );
}

/** Which language the resource is written in: stated, changeable, detectable. */
function SourceRow({
  data,
  selected,
  fetcher,
  busy,
  options,
}: {
  data: ReadData;
  selected: Selected;
  fetcher: ReturnType<typeof useFetcher<typeof action>>;
  busy: boolean;
  options: { value: string; label: string }[];
}) {
  const suggestion =
    selected.detectedLocale && selected.detectedLocale !== selected.sourceLocale
      ? `Looks like ${localeLabel(selected.detectedLocale)}.`
      : null;
  return (
    <s-grid
      gridTemplateColumns="@container workspace (inline-size <= 640px) 1fr, 'auto minmax(200px, 320px) auto minmax(0, 1fr)'"
      gap="small-300"
      alignItems="center"
    >
      <s-text color="subdued">Written in</s-text>
      <Dropdown
        name="source"
        label="Written in"
        hideLabel
        value={selected.sourceIsOverride ? selected.sourceLocale : ""}
        options={options}
        onChange={(next) =>
          fetcher.submit(
            {
              intent: "set-source",
              resource: selected.id,
              type: selected.type,
              source: next,
            },
            { method: "post" },
          )
        }
        disabled={busy}
      />
      <s-button
        variant="tertiary"
        onClick={() =>
          fetcher.submit(
            {
              intent: "detect-source",
              resource: selected.id,
              type: selected.type,
            },
            { method: "post" },
          )
        }
        {...(busy || !data.aiConfigured ? { disabled: true } : {})}
      >
        Detect
      </s-button>
      <s-text color="subdued">
        {suggestion ??
          (selected.sourceIsOverride
            ? "Translated directly from this language, never through the store default."
            : selected.sourceLocale === data.locale
              ? `Written in ${localeLabel(data.locale)} already, so there is nothing to translate.`
              : "")}
      </s-text>
    </s-grid>
  );
}

type Field = Selected["fields"][number];

/** One line, so a field's two columns start together. */
const HEADER_ROW = {
  minHeight: "32px",
  display: "grid",
  alignItems: "center",
} as const;

/** One field: its source on the left, its translation on the right. */
function FieldRow({
  field,
  sourceLocale,
  targetLocale,
  value,
  busy,
  full,
  onChange,
  onFull,
}: {
  field: Field;
  sourceLocale: string;
  targetLocale: string;
  value: string;
  busy: boolean;
  /** This field has the whole dialog to itself. */
  full: boolean;
  onChange: (value: string) => void;
  onFull: (full: boolean) => void;
}) {
  const html = field.type === "HTML";
  const long = html || field.source.length > 120 || field.source.includes("\n");
  // Lines the source takes at about ninety characters a line, so the
  // translation's box opens as tall as the source it sits beside; past
  // twenty lines both scroll at the same height.
  const lines = field.source
    .split("\n")
    .reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 90)), 0);
  const rows = Math.min(20, Math.max(3, lines + 1));
  const targetLabel = `${field.label} · ${localeLabel(targetLocale)}`;

  // An embed or a table cannot survive rich text editing, so those fields
  // open — and stay — as HTML, and the switch says why.
  const sourceOnly =
    html && (needsSourceEditing(field.source) || needsSourceEditing(value));
  const [view, setView] = useState<HtmlView>(sourceOnly ? "source" : "rich");
  const shown: HtmlView = sourceOnly ? "source" : view;
  // In the full editor a field takes what the dialog has; otherwise it is as
  // tall as its own source, and both columns are that same height.
  const boxHeight = full ? "calc(100vh - 380px)" : `${rows * 20 + 24}px`;
  const textRows = full ? 30 : rows;

  /*
   * The strip across the source, level with the editor's toolbar so the two
   * columns start their first line together. It carries the one thing a
   * translator wants from the source itself: a copy of it to work over,
   * which Discard takes back like any other edit.
   */
  const sourceStrip = html ? (
    <s-button
      variant="tertiary"
      icon="duplicate"
      onClick={() => onChange(field.source)}
      {...(busy ? { disabled: true } : {})}
    >
      Copy to translation
    </s-button>
  ) : null;

  return (
    <s-grid
      gridTemplateColumns={`@container workspace (inline-size <= 720px) 1fr, 'minmax(0, 1fr) minmax(0, 1fr)'`}
      gap="base"
      alignItems="start"
    >
      <s-stack direction="block" gap="small-400">
        {/*
         * Both headers are one line tall whatever they hold — a name on the
         * left, buttons on the right — so the two boxes under them start on
         * the same line.
         */}
        <div style={HEADER_ROW}>
          <s-stack direction="inline" gap="small-300" alignItems="center">
            <s-text type="strong">{field.label}</s-text>
            <FieldStateBadge state={field.state} />
            <s-text color="subdued">{localeLabel(sourceLocale)}</s-text>
          </s-stack>
        </div>
        {/*
         * The source box is as tall as its text, never stretched to the
         * translation beside it: a box stretched to the row's height starts
         * at the row's top and covers its own label.
         */}
        {html ? (
          field.source === "" ? (
            <s-box
              padding="small-200"
              border="base"
              borderRadius="base"
              background="subdued"
            >
              <s-text color="subdued">Empty</s-text>
            </s-box>
          ) : shown === "rich" ? (
            <HtmlPreview
              html={field.source}
              blockSize={boxHeight}
              label={`${field.label} · ${localeLabel(sourceLocale)}`}
              strip={sourceStrip}
            />
          ) : (
            <HtmlSource
              html={field.source}
              blockSize={boxHeight}
              label={`${field.label} · ${localeLabel(sourceLocale)}`}
              strip={sourceStrip}
            />
          )
        ) : (
          <s-box
            padding="small-200"
            border="base"
            borderRadius="base"
            background="subdued"
          >
            {/*
             * Source text keeps its line breaks and scrolls past a screen's
             * worth rather than being cut off; a translator needs all of it.
             */}
            <div
              style={{
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
                ...(long
                  ? { height: boxHeight, overflowY: "auto" }
                  : { minHeight: "20px" }),
              }}
            >
              {field.source === "" ? (
                <s-text color="subdued">Empty</s-text>
              ) : (
                <s-text>{field.source}</s-text>
              )}
            </div>
          </s-box>
        )}
      </s-stack>

      <s-stack direction="block" gap="small-400">
        <div style={HEADER_ROW}>
          <s-stack
            direction="inline"
            gap="small-300"
            alignItems="center"
            justifyContent="space-between"
          >
            <s-stack direction="inline" gap="small-300" alignItems="center">
              <s-text color="subdued">{localeLabel(targetLocale)}</s-text>
              {html ? (
                <HtmlViewSwitch
                  view={shown}
                  onChange={setView}
                  richDisabled={sourceOnly}
                  disabledReason="This field has an embed or a table in it, which rich text editing would rewrite. Edit it as HTML."
                />
              ) : null}
              {/* A long field can have the dialog to itself and give it back. */}
              {long ? (
                <s-button
                  variant="tertiary"
                  icon={full ? "minimize" : "maximize"}
                  accessibilityLabel={
                    full ? "Back to all fields" : "Open the full editor"
                  }
                  onClick={() => onFull(!full)}
                />
              ) : null}
            </s-stack>
            <s-text color="subdued">
              {!field.prose && field.key === "handle"
                ? "Not translated by AI; a translated handle changes the URL."
                : field.updatedAt
                  ? `Updated ${formatListDateTime(field.updatedAt)}`
                  : ""}
            </s-text>
          </s-stack>
        </div>
        {html && shown === "rich" ? (
          <HtmlEditor
            value={value}
            onChange={onChange}
            blockSize={boxHeight}
            label={targetLabel}
            placeholder="Not translated yet"
            busy={busy}
          />
        ) : long ? (
          <s-text-area
            label={targetLabel}
            labelAccessibilityVisibility="exclusive"
            placeholder="Not translated yet"
            rows={textRows}
            value={value}
            onInput={(event) => onChange(event.currentTarget.value)}
            onChange={(event) => onChange(event.currentTarget.value)}
            {...(busy ? { disabled: true } : {})}
          />
        ) : (
          <s-text-field
            label={targetLabel}
            labelAccessibilityVisibility="exclusive"
            placeholder="Not translated yet"
            value={value}
            onInput={(event) => onChange(event.currentTarget.value)}
            onChange={(event) => onChange(event.currentTarget.value)}
            {...(busy ? { disabled: true } : {})}
          />
        )}
      </s-stack>
    </s-grid>
  );
}

/**
 * Colour marks what needs a person: missing and outdated. Who wrote an
 * existing translation is information, not an alarm.
 */
function FieldStateBadge({ state }: { state: FieldState }) {
  const tone =
    state === "missing"
      ? ("warning" as const)
      : state === "outdated"
        ? ("critical" as const)
        : state === "ai"
          ? ("info" as const)
          : ("neutral" as const);
  return (
    <s-badge tone={tone} size="base">
      {FIELD_STATE_LABEL[state]}
    </s-badge>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
