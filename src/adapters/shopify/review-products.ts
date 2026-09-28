import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";

import {
  REVIEW_TAG,
  isAwaitingReview,
  sourceIdFromTags,
} from "~/domain/export-portal/review";

/**
 * Products the export portal created as drafts for a person to review
 * (docs/sources.md § Review before publish).
 *
 * The portal writes the product; this app only reads the drafts and, on
 * approval, makes the one write the portal does not: status to ACTIVE and
 * the review tag off. A draft is hidden on every sales channel it is
 * published to, so approving needs no publication scopes — the portal has
 * already put the product on the channels its source names.
 */

const errorsSchema = z
  .array(z.object({ message: z.string() }).passthrough())
  .optional();

const productNodeSchema = z.object({
  id: z.string(),
  legacyResourceId: z.string(),
  title: z.string(),
  handle: z.string(),
  status: z.string(),
  vendor: z.string().nullable(),
  tags: z.array(z.string()),
  createdAt: z.string(),
  featuredMedia: z
    .object({
      preview: z
        .object({
          image: z.object({ url: z.string() }).nullable(),
        })
        .nullable(),
    })
    .nullable(),
});

const LIST_QUERY = `#graphql
  query OrchestratorReviewProducts(
    $query: String!
    $first: Int
    $last: Int
    $after: String
    $before: String
  ) {
    products(
      query: $query
      first: $first
      last: $last
      after: $after
      before: $before
      sortKey: CREATED_AT
      reverse: true
    ) {
      pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
      nodes {
        id
        legacyResourceId
        title
        handle
        status
        vendor
        tags
        createdAt
        featuredMedia {
          preview { image { url(transform: { maxWidth: 80, maxHeight: 80 }) } }
        }
      }
    }
    productsCount(query: $query) { count precision }
  }
`;

export const reviewListSchema = z.object({
  data: z
    .object({
      products: z.object({
        pageInfo: z.object({
          hasNextPage: z.boolean(),
          hasPreviousPage: z.boolean(),
          startCursor: z.string().nullable(),
          endCursor: z.string().nullable(),
        }),
        nodes: z.array(productNodeSchema),
      }),
      productsCount: z
        .object({ count: z.number(), precision: z.string() })
        .nullable(),
    })
    .nullable()
    .optional(),
  errors: errorsSchema,
});

export interface ReviewProduct {
  id: string;
  /** The number the Shopify admin addresses the product by. */
  legacyId: string;
  title: string;
  handle: string;
  vendor: string | null;
  sourceId: string | null;
  createdAt: string;
  imageUrl: string | null;
}

export interface ReviewPage {
  products: ReviewProduct[];
  total: number;
  /** False when Shopify stopped counting, so `total` is a floor. */
  exact: boolean;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

export function toReviewPage(raw: unknown): ReviewPage {
  const parsed = reviewListSchema.parse(raw);
  if (parsed.errors && parsed.errors.length > 0)
    throw new Error(parsed.errors.map((e) => e.message).join("; "));
  if (!parsed.data) throw new Error("Shopify returned no products.");
  const { products, productsCount } = parsed.data;
  return {
    products: products.nodes.map((node) => ({
      id: node.id,
      legacyId: node.legacyResourceId,
      title: node.title,
      handle: node.handle,
      vendor: node.vendor,
      sourceId: sourceIdFromTags(node.tags),
      createdAt: node.createdAt,
      imageUrl: node.featuredMedia?.preview?.image?.url ?? null,
    })),
    total: productsCount?.count ?? products.nodes.length,
    exact: productsCount?.precision !== "AT_LEAST",
    ...products.pageInfo,
  };
}

/**
 * One page of what is waiting, newest first. `before` pages back; either
 * cursor alone, never both.
 */
export async function listReviewProducts(
  admin: AdminApiContext,
  input: {
    query: string;
    pageSize: number;
    after?: string | null;
    before?: string | null;
  },
): Promise<ReviewPage> {
  const backwards = Boolean(input.before);
  const response = await admin.graphql(LIST_QUERY, {
    variables: {
      query: input.query,
      first: backwards ? null : input.pageSize,
      last: backwards ? input.pageSize : null,
      after: backwards ? null : (input.after ?? null),
      before: backwards ? input.before : null,
    },
    tries: 2,
  });
  return toReviewPage(await response.json());
}

const COUNT_QUERY = `#graphql
  query OrchestratorReviewCount($query: String!) {
    productsCount(query: $query) { count }
  }
`;

const countSchema = z.object({
  data: z
    .object({
      productsCount: z.object({ count: z.number() }).nullable(),
    })
    .nullable()
    .optional(),
  errors: errorsSchema,
});

/** How many are waiting; what the Sources pages show beside a link. */
export async function countReviewProducts(
  admin: AdminApiContext,
  query: string,
): Promise<number> {
  const response = await admin.graphql(COUNT_QUERY, {
    variables: { query },
  });
  const parsed = countSchema.parse(await response.json());
  if (parsed.errors && parsed.errors.length > 0)
    throw new Error(parsed.errors.map((e) => e.message).join("; "));
  return parsed.data?.productsCount?.count ?? 0;
}

/* -------------------------------------------------------------------------- */
/* Approving                                                                  */
/* -------------------------------------------------------------------------- */

/** At most this many in one request: two mutations each, well inside the query cost limit. */
export const APPROVE_BATCH = 25;

const STATE_QUERY = `#graphql
  query OrchestratorReviewState($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product { id title status tags }
    }
  }
`;

const stateSchema = z.object({
  data: z
    .object({
      nodes: z.array(
        z
          .object({
            id: z.string().optional(),
            title: z.string().optional(),
            status: z.string().optional(),
            tags: z.array(z.string()).optional(),
          })
          .nullable(),
      ),
    })
    .nullable()
    .optional(),
  errors: errorsSchema,
});

/**
 * One document approving several products: for each, `productUpdate` to
 * ACTIVE and `tagsRemove` of the review tag, aliased by position so one
 * round trip answers for all of them. `tagsRemove` rather than writing
 * `tags` on the update: the update would replace every tag, and the tags
 * are not this app's.
 */
export function approveDocument(count: number): string {
  const variables: string[] = [];
  const fields: string[] = [];
  for (let i = 0; i < count; i += 1) {
    variables.push(`$id${i}: ID!`);
    fields.push(
      `p${i}: productUpdate(product: { id: $id${i}, status: ACTIVE }) { product { id status } userErrors { field message } }`,
      `t${i}: tagsRemove(id: $id${i}, tags: $tags) { userErrors { field message } }`,
    );
  }
  return `mutation OrchestratorApproveReview(${[...variables, "$tags: [String!]!"].join(", ")}) {\n  ${fields.join("\n  ")}\n}`;
}

export function approveVariables(ids: readonly string[]) {
  const variables: Record<string, string | string[]> = { tags: [REVIEW_TAG] };
  ids.forEach((id, i) => {
    variables[`id${i}`] = id;
  });
  return variables;
}

const userErrorsSchema = z.array(z.object({ message: z.string() }));

const approveSchema = z.object({
  data: z
    .record(
      z.string(),
      z
        .object({
          product: z
            .object({ id: z.string(), status: z.string() })
            .nullable()
            .optional(),
          userErrors: userErrorsSchema,
        })
        .nullable(),
    )
    .nullable()
    .optional(),
  errors: errorsSchema,
});

export interface ApproveOutcome {
  id: string;
  title: string | null;
  ok: boolean;
  /** Why not, in words a person can act on; null when it went through. */
  message: string | null;
}

/**
 * Sets the named drafts active and takes their review tag off. A product
 * that is not waiting any more — approved already, or set active or
 * archived in the admin — is reported and left alone, so a stale page
 * cannot publish something nobody meant to.
 */
export async function approveReviewProducts(
  admin: AdminApiContext,
  ids: readonly string[],
): Promise<ApproveOutcome[]> {
  const unique = [...new Set(ids)].slice(0, APPROVE_BATCH);
  if (unique.length === 0) return [];

  const stateResponse = await admin.graphql(STATE_QUERY, {
    variables: { ids: unique },
  });
  const state = stateSchema.parse(await stateResponse.json());
  if (state.errors && state.errors.length > 0)
    throw new Error(state.errors.map((e) => e.message).join("; "));
  const found = new Map(
    (state.data?.nodes ?? []).flatMap((node) =>
      node?.id ? [[node.id, node] as const] : [],
    ),
  );

  const outcomes = new Map<string, ApproveOutcome>();
  const approvable: string[] = [];
  for (const id of unique) {
    const node = found.get(id);
    if (!node || node.status === undefined) {
      outcomes.set(id, {
        id,
        title: null,
        ok: false,
        message: "The product no longer exists in Shopify.",
      });
    } else if (
      !isAwaitingReview({ status: node.status, tags: node.tags ?? [] })
    ) {
      outcomes.set(id, {
        id,
        title: node.title ?? null,
        ok: false,
        message: "It is no longer waiting for review.",
      });
    } else {
      approvable.push(id);
    }
  }

  if (approvable.length > 0) {
    const response = await admin.graphql(approveDocument(approvable.length), {
      variables: approveVariables(approvable),
    });
    const parsed = approveSchema.parse(await response.json());
    if (!parsed.data && parsed.errors && parsed.errors.length > 0)
      throw new Error(parsed.errors.map((e) => e.message).join("; "));
    approvable.forEach((id, i) => {
      const update = parsed.data?.[`p${i}`];
      const untag = parsed.data?.[`t${i}`];
      const problems = [
        ...(update?.userErrors ?? []),
        ...(untag?.userErrors ?? []),
      ].map((e) => e.message);
      const active = update?.product?.status === "ACTIVE";
      outcomes.set(id, {
        id,
        title: found.get(id)?.title ?? null,
        ok: active,
        message: active
          ? problems.length > 0
            ? `Published, but the review tag stayed: ${problems.join("; ")}`
            : null
          : problems.join("; ") || "Shopify did not set it active.",
      });
    });
  }

  return unique.flatMap((id) => {
    const outcome = outcomes.get(id);
    return outcome ? [outcome] : [];
  });
}
