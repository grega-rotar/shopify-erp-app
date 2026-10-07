import type { Job } from "pg-boss";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * docs/attributes.md § AI autofill, "autofill all": the job walks the
 * catalogue a pass of ten at a time, marking products queued only as their
 * turn comes, hands over to a fresh job from where it stopped, and stops at
 * the end or when the portal cannot be asked.
 */

const state = vi.hoisted(() => ({
  available: true,
  walk: { ids: [] as string[], next: null as string | null },
  walkedFrom: [] as Array<string | null>,
  suggested: [] as Array<{ ids: string[]; options: unknown }>,
  enqueued: [] as unknown[],
}));

vi.mock("~/adapters/db/repositories/product-autofill.server", () => ({
  nextUnaskedProducts: async (_p: unknown, after: string | null) => {
    state.walkedFrom.push(after);
    return state.walk;
  },
  queueAutofills: async (_p: unknown, ids: string[]) => ids,
  failAutofill: async () => undefined,
}));
vi.mock("~/adapters/products/autofill.server", () => ({
  autofillAvailability: async () =>
    state.available
      ? { ok: true }
      : { ok: false, message: "Connect the export portal first." },
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
