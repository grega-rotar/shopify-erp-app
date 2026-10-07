import type { Job } from "pg-boss";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * docs/attributes.md § AI autofill, "autofill all": the job walks the
 * catalogue a pass of ten at a time, marking products queued only as their
 * turn comes, hands over to a fresh job from where it stopped, and stops at
 * the end or when the portal cannot be asked. "Apply all" and a large
 * selection apply ten suggestions a pass the same way.
 */

const state = vi.hoisted(() => ({
  available: true,
  walk: { ids: [] as string[], next: null as string | null },
  walkedFrom: [] as Array<string | null>,
  suggested: [] as Array<{ ids: string[]; options: unknown }>,
  enqueued: [] as unknown[],
  ready: [] as string[],
  applied: [] as Array<{ productId: string; actor: string | null }>,
  refuse: new Set<string>(),
}));

vi.mock("~/adapters/db/repositories/product-autofill.server", () => ({
  nextUnaskedProducts: async (_p: unknown, after: string | null) => {
    state.walkedFrom.push(after);
    return state.walk;
  },
  queueAutofills: async (_p: unknown, ids: string[]) => ids,
  failAutofill: async () => undefined,
  nextReadyAutofills: async (
    _p: unknown,
    after: string | null,
    limit: number,
  ) => state.ready.filter((id) => after === null || id > after).slice(0, limit),
}));
vi.mock("~/adapters/products/autofill.server", () => ({
  autofillAvailability: async () =>
    state.available
      ? { ok: true }
      : { ok: false, message: "Connect the export portal first." },
  applyAutofill: async (
    _a: unknown,
    _p: unknown,
    input: { productId: string; actor: string | null },
  ) => {
    if (state.refuse.has(input.productId))
      return { ok: false, message: "Shopify refused the values." };
    state.applied.push({ productId: input.productId, actor: input.actor });
    return { ok: true, message: "Applied." };
  },
  suggestAutofill: async (
    _a: unknown,
    _p: unknown,
    ids: string[],
    options: unknown,
  ) => {
    state.suggested.push({ ids, options });
  },
}));
vi.mock("~/adapters/queue/boss.server", () => ({
  enqueue: async (_name: string, data: unknown) => {
    state.enqueued.push(data);
    return "job";
  },
}));
vi.mock("~/adapters/shopify/shopify.server", () => ({
  unauthenticated: { admin: async () => ({ admin: {} }) },
}));

const { handleProductAutofill } =
  await import("~/jobs/handlers/product-autofill");

const allJob = (after: string | null) =>
  ({
    data: {
      shopDomain: "shop.myshopify.com",
      all: { after },
      autoApply: true,
      requestedBy: "staff:1",
    },
  }) as Job<unknown>;

beforeEach(() => {
  state.available = true;
  state.walk = { ids: [], next: null };
  state.walkedFrom = [];
  state.suggested = [];
  state.enqueued = [];
  state.ready = [];
  state.applied = [];
  state.refuse = new Set();
});

const applyJob = (apply: { ids: string[] | null; after: string | null }) =>
  ({
    data: { shopDomain: "shop.myshopify.com", apply, requestedBy: "staff:1" },
  }) as Job<unknown>;

const ids = (n: number) =>
  Array.from({ length: n }, (_, i) => `p${String(i).padStart(2, "0")}`);

describe("apply all", () => {
  it("applies ten waiting suggestions and hands over from the last", async () => {
    state.ready = ids(12);
    await handleProductAutofill(applyJob({ ids: null, after: null }));

    expect(state.applied.map((a) => a.productId)).toEqual(ids(10));
    expect(state.applied[0]?.actor).toBe("staff:1");
    expect(state.enqueued).toEqual([
      expect.objectContaining({ apply: { ids: null, after: "p09" } }),
    ]);
  });

  it("steps over a suggestion Shopify refuses instead of looping on it", async () => {
    state.ready = ids(3);
    state.refuse = new Set(["p01"]);
    await handleProductAutofill(applyJob({ ids: null, after: null }));

    expect(state.applied.map((a) => a.productId)).toEqual(["p00", "p02"]);
    expect(state.enqueued).toEqual([]);
  });

  it("works through a selection ten at a time", async () => {
    await handleProductAutofill(applyJob({ ids: ids(13), after: null }));

    expect(state.applied).toHaveLength(10);
    expect(state.enqueued).toEqual([
      expect.objectContaining({
        apply: { ids: ["p10", "p11", "p12"], after: null },
      }),
    ]);
  });
});

describe("autofill all", () => {
  it("suggests for one pass and hands over from where it stopped", async () => {
    state.walk = { ids: ["p1", "p2"], next: "p2" };
    await handleProductAutofill(allJob(null));

    expect(state.walkedFrom).toEqual([null]);
    expect(state.suggested).toEqual([
      {
        ids: ["p1", "p2"],
        options: {
          fillAttributes: true,
          autoApply: true,
          requestedBy: "staff:1",
        },
      },
    ]);
    expect(state.enqueued).toEqual([
      expect.objectContaining({
        all: { after: "p2" },
        autoApply: true,
        requestedBy: "staff:1",
      }),
    ]);
  });

  it("stops at the end of the catalogue", async () => {
    state.walk = { ids: ["p9"], next: null };
    await handleProductAutofill(allJob("p8"));

    expect(state.walkedFrom).toEqual(["p8"]);
    expect(state.suggested).toHaveLength(1);
    expect(state.enqueued).toEqual([]);
  });

  it("stops rather than failing every product when the portal cannot be asked", async () => {
    state.available = false;
    state.walk = { ids: ["p1"], next: "p1" };
    await handleProductAutofill(allJob(null));

    expect(state.walkedFrom).toEqual([]);
    expect(state.suggested).toEqual([]);
    expect(state.enqueued).toEqual([]);
  });
});
