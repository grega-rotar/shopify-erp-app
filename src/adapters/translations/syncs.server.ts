import type { Prisma } from "@prisma/client";

import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import {
  appendToCollectingSync,
  createSync,
  recordLanguageSync,
  type Sync,
} from "~/adapters/db/repositories/translations.server";
import {
  enqueue,
  enqueueThrottled,
  latestJobForKey,
} from "~/adapters/queue/boss.server";
import {
  QUEUES,
  translationCoverageKey,
  translationProfileKey,
  translationSyncKey,
} from "~/adapters/queue/queues";
import type { ResourceType, SyncMode } from "~/domain/translations/types";
import type { Principal } from "~/domain/types";

/**
 * Starting work (docs/translations.md § Jobs). Shared by the pages and the
 * nightly tick so a sync is created and queued in one way.
 */

export interface StartSyncInput {
  kind: "translate_store" | "language" | "automatic" | "resource";
  mode: SyncMode;
  sourceLocale: string;
  targetLocales: string[];
  resourceTypes: ResourceType[];
  resourceIds?: string[];
  estimate?: Prisma.InputJsonValue | null;
  requestedBy: string | null;
}

export async function startSync(
  principal: Principal,
  input: StartSyncInput,
): Promise<Sync> {
  const sync = await createSync(principal, input);
  await recordLanguageSync(principal, input.targetLocales, "started", new Date());
  await enqueue(
    QUEUES.translationSync,
    { shopDomain: principal.shopDomain, syncId: sync.id },
    { singletonKey: translationSyncKey(sync.id) },
  );
  await appendEvent(principal, {
    entityType: "translation_sync",
    entityId: sync.id,
    event: "translation_sync.started",
    detail: {
      kind: input.kind,
      mode: input.mode,
      targetLocales: input.targetLocales,
      resourceTypes: input.resourceTypes,
      resources: input.resourceIds?.length ?? null,
      by: input.requestedBy,
    },
  });
  return sync;
}

/**
 * How long changed resources are collected before one sync translates them
 * together (docs/translations.md § Automatic translation). Shopify sends one
 * webhook per product, and a CSV import or a bulk edit sends hundreds in a
 * minute; one sync per webhook would be a syncs page nobody can read.
 */
export const COLLECT_WINDOW_SECONDS = 120;

/**
 * Puts a resource Shopify says has changed on the sync that is collecting
 * changes for these languages and mode, opening one when there is none.
 * The sync runs `COLLECT_WINDOW_SECONDS` after it was opened; the job is
 * sent once per sync (its singleton key), so every later call in the window
 * only lengthens the list. A sync that has started is not added to — the
 * next change opens the next one.
 */
export async function collectChangedResource(
  principal: Principal,
  input: {
    resourceId: string;
    resourceType: ResourceType;
    sourceLocale: string;
    targetLocales: string[];
    mode: SyncMode;
  },
): Promise<{ sync: Sync; opened: boolean; added: boolean }> {
  const appended = await appendToCollectingSync(principal, input);
  if (appended) return { ...appended, opened: false };

  const sync = await createSync(principal, {
    kind: "resource",
    mode: input.mode,
    sourceLocale: input.sourceLocale,
    targetLocales: input.targetLocales,
    resourceTypes: [input.resourceType],
    resourceIds: [input.resourceId],
    requestedBy: null,
  });
  await recordLanguageSync(principal, input.targetLocales, "started", new Date());
  await enqueue(
    QUEUES.translationSync,
    { shopDomain: principal.shopDomain, syncId: sync.id },
    {
      singletonKey: translationSyncKey(sync.id),
      startAfterSeconds: COLLECT_WINDOW_SECONDS,
    },
  );
  await appendEvent(principal, {
    entityType: "translation_sync",
    entityId: sync.id,
    event: "translation_sync.started",
    detail: {
      kind: "resource",
      mode: input.mode,
      targetLocales: input.targetLocales,
      resourceTypes: [input.resourceType],
      resources: 1,
      by: null,
      collecting: COLLECT_WINDOW_SECONDS,
    },
  });
  return { sync, opened: true, added: true };
}

/** Asks for the coverage cache to be re-read; null when one is already pending. */
export async function requestCoverageRefresh(
  principal: Principal,
  windowSeconds = 300,
): Promise<string | null> {
  return enqueueThrottled(
    QUEUES.translationCoverage,
    { shopDomain: principal.shopDomain },
    translationCoverageKey(principal.shopDomain),
    windowSeconds,
  );
}

/**
 * What became of the last coverage count (docs/translations.md § Coverage):
 * one is waiting or running, or the last one failed and the cache is older
 * than that failure. The Languages page shows both; without them a count
 * that failed on the worker looks like a button that does nothing.
 */
export interface CoverageCountState {
  counting: boolean;
  failed: { at: Date; reason: string } | null;
}

export async function coverageCountState(
  principal: Principal,
  countedAt: Date | null,
): Promise<CoverageCountState> {
  const job = await latestJobForKey(
    QUEUES.translationCoverage,
    translationCoverageKey(principal.shopDomain),
  );
  if (!job) return { counting: false, failed: null };
  const counting =
    job.state === "created" || job.state === "retry" || job.state === "active";
  const failedAt = job.completedOn ?? job.createdOn;
  const failed =
    job.state === "failed" && (!countedAt || failedAt > countedAt)
      ? { at: failedAt, reason: job.error ?? "The job failed without a reason." }
      : null;
  return { counting, failed };
}

/**
 * Asks for the store profile to be rebuilt from a fresh read of the store
 * (docs/translations.md § Store profile); null when a rebuild is already
 * waiting.
 */
export async function requestProfileRebuild(principal: Principal): Promise<string | null> {
  return enqueueThrottled(
    QUEUES.translationProfile,
    { shopDomain: principal.shopDomain },
    translationProfileKey(principal.shopDomain),
    60,
  );
}
