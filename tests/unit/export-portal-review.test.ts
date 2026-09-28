import { describe, expect, it, vi } from "vitest";

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import {
  approveDocument,
  approveReviewProducts,
  approveVariables,
  toReviewPage,
} from "~/adapters/shopify/review-products";
import {
  REVIEW_TAG,
  isAwaitingReview,
  reviewQuery,
  sourceIdFromTags,
  translationGaps,
} from "~/domain/export-portal/review";
import type {
  ExistingTranslation,
  SourceField,
} from "~/domain/translations/types";

/**
 * Review before publish (docs/sources.md § Review before publish): which
 * products are waiting, what each still lacks, and that approving only
 * ever publishes a product that really is waiting.
 */

const field = (key: string, value = "Text", type = "STRING"): SourceField => ({
  key,
  value,
  digest: `d-${key}`,
  type,
});
const translation = (
  key: string,
  value = "Besedilo",
  outdated = false,
): ExistingTranslation => ({ key, value, outdated, updatedAt: null });

describe("the review search", () => {
  it("asks for drafts carrying the review tag", () => {
    expect(reviewQuery({})).toBe(`tag:"${REVIEW_TAG}" AND status:draft`);
  });

  it("narrows to one source and a search, quoting what the person typed", () => {
    expect(reviewQuery({ sourceId: "src_1", search: ' Blue "XL" ' })).toBe(
      `tag:"${REVIEW_TAG}" AND status:draft AND tag:"portal-source:src_1" AND "Blue \\"XL\\""`,
    );
  });

  it("reads the source off the tags, and nothing when no tag names one", () => {
    expect(sourceIdFromTags(["new", "portal-source:src_9"])).toBe("src_9");
    expect(sourceIdFromTags(["new", "portal-source:"])).toBeNull();
    expect(sourceIdFromTags([])).toBeNull();
  });

  it("counts a product as waiting only while it is a draft with the tag", () => {
    expect(isAwaitingReview({ status: "DRAFT", tags: [REVIEW_TAG] })).toBe(
      true,
    );
    expect(isAwaitingReview({ status: "ACTIVE", tags: [REVIEW_TAG] })).toBe(
      false,
    );
    expect(isAwaitingReview({ status: "DRAFT", tags: [] })).toBe(false);
  });
});

describe("what a product still lacks", () => {
  const fields = [
    field("title"),
    field("body_html", "<p>Hi</p>", "HTML"),
    field("handle", "blue-shirt", "URI"),
    field("empty", ""),
  ];

  it("counts missing and outdated per language, leaving complete languages out", () => {
    const gaps = translationGaps({
      fields,
      translations: new Map([
        ["de", [translation("title"), translation("body_html", "x", true)]],
        ["hr", [translation("title"), translation("body_html")]],
        ["it", []],
      ]),
      locales: ["de", "hr", "it"],
      kept: () => new Set(),
    });
    expect(gaps).toEqual([
      { locale: "de", missing: 0, outdated: 1 },
      { locale: "it", missing: 2, outdated: 0 },
    ]);
  });

  it("does not count a field the language keeps in the original", () => {
    const gaps = translationGaps({
      fields,
      translations: new Map([["de", [translation("body_html")]]]),
      locales: ["de"],
      kept: (locale) => new Set(locale === "de" ? ["title"] : []),
    });
    expect(gaps).toEqual([]);
  });
});

describe("the review list payload", () => {
  const node = {
    id: "gid://shopify/Product/1",
    legacyResourceId: "1",
    title: "Blue shirt",
    handle: "blue-shirt",
    status: "DRAFT",
    vendor: null,
    tags: [REVIEW_TAG, "portal-source:src_1"],
    createdAt: "2026-09-27T10:00:00Z",
    featuredMedia: null,
  };

  it("maps each product and says when the count is a floor", () => {
    const page = toReviewPage({
      data: {
        products: {
          pageInfo: {
            hasNextPage: true,
            hasPreviousPage: false,
            startCursor: "a",
            endCursor: "b",
          },
          nodes: [node],
        },
        productsCount: { count: 10000, precision: "AT_LEAST" },
      },
    });
    expect(page.products).toEqual([
      {
        id: node.id,
        legacyId: "1",
        title: "Blue shirt",
        handle: "blue-shirt",
        vendor: null,
        sourceId: "src_1",
        createdAt: node.createdAt,
        imageUrl: null,
      },
    ]);
    expect(page.total).toBe(10000);
    expect(page.exact).toBe(false);
    expect(page.hasNextPage).toBe(true);
  });

  it("throws Shopify's errors rather than showing an empty queue", () => {
    expect(() =>
      toReviewPage({ data: null, errors: [{ message: "Throttled" }] }),
    ).toThrow("Throttled");
  });
});

describe("approving", () => {
  it("sets each product active and removes only the review tag", () => {
    const document = approveDocument(2);
    expect(document).toContain(
      "p0: productUpdate(product: { id: $id0, status: ACTIVE })",
    );
    expect(document).toContain("t1: tagsRemove(id: $id1, tags: $tags)");
    // The update never writes `tags`: that would replace every tag on the product.
    expect(document).not.toMatch(/productUpdate\([^)]*tags/);
    expect(approveVariables(["gid://shopify/Product/1"])).toEqual({
      tags: [REVIEW_TAG],
      id0: "gid://shopify/Product/1",
    });
  });

  function fakeAdmin(...results: unknown[]) {
    const queue = [...results];
    const graphql = vi.fn(
      async () =>
        new Response(JSON.stringify(queue.shift()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    return { admin: { graphql } as unknown as AdminApiContext, graphql };
  }

  it("publishes only products still waiting and reports the rest", async () => {
    const { admin, graphql } = fakeAdmin(
      {
        data: {
          nodes: [
            {
              id: "gid://shopify/Product/1",
              title: "Waiting",
              status: "DRAFT",
              tags: [REVIEW_TAG],
            },
            {
              id: "gid://shopify/Product/2",
              title: "Already live",
              status: "ACTIVE",
              tags: [],
            },
            null,
          ],
        },
      },
      {
        data: {
          p0: {
            product: { id: "gid://shopify/Product/1", status: "ACTIVE" },
            userErrors: [],
          },
          t0: { userErrors: [] },
        },
      },
    );

    const outcomes = await approveReviewProducts(admin, [
      "gid://shopify/Product/1",
      "gid://shopify/Product/2",
      "gid://shopify/Product/3",
    ]);

    expect(outcomes.map((o) => [o.id, o.ok])).toEqual([
      ["gid://shopify/Product/1", true],
      ["gid://shopify/Product/2", false],
      ["gid://shopify/Product/3", false],
    ]);
    // Only the waiting product reached the mutation.
    expect(graphql).toHaveBeenCalledTimes(2);
    const [, options] = graphql.mock.calls[1] as unknown as [
      string,
      { variables: Record<string, unknown> },
    ];
    expect(options.variables).toEqual({
      tags: [REVIEW_TAG],
      id0: "gid://shopify/Product/1",
    });
  });

  it("does not call the mutation when nothing is waiting", async () => {
    const { admin, graphql } = fakeAdmin({
      data: {
        nodes: [
          {
            id: "gid://shopify/Product/2",
            title: "Archived",
            status: "ARCHIVED",
            tags: [REVIEW_TAG],
          },
        ],
      },
    });
    const outcomes = await approveReviewProducts(admin, [
      "gid://shopify/Product/2",
    ]);
    expect(outcomes[0]?.ok).toBe(false);
    expect(graphql).toHaveBeenCalledTimes(1);
  });
});
