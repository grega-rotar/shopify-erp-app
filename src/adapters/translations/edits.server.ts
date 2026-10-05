import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import { isConfigured } from "~/adapters/ai/openai.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import {
  forgetMemory,
  rememberTranslations,
} from "~/adapters/db/repositories/translation-intelligence.server";
import {
  forgetOwnership,
  getSourceOverride,
  recordOwnership,
} from "~/adapters/db/repositories/translations.server";
import { listShopLocales } from "~/adapters/shopify/locales";
import {
  readTranslatableResourcesByIds,
  registerTranslations,
  removeTranslations,
} from "~/adapters/shopify/translations";
import { hashValue } from "~/adapters/translations/engine.server";
import { translateResourceNow } from "~/adapters/translations/inline.server";
import { isMemorable, memoryKey } from "~/domain/translations/memory";
import type { ResourceType, SyncMode } from "~/domain/translations/types";
import type { Principal } from "~/domain/types";

/**
 * What a person does to one resource's translations, whichever page they do
 * it from (docs/translations.md § Ownership and overwrite): the translation
 * editor and the product workspace both save and translate through here, so
 * a person's edit is recorded as theirs, remembered, and audited the same
 * way everywhere.
 */

export interface EditResult {
  ok: boolean;
  message: string;
}

export interface FieldEdit {
  key: string;
  value: string;
  /** The source digest the translation was written against. */
  digest: string;
}

/**
 * Saves a person's translations of one resource in one language: a value
 * is registered in Shopify and recorded as `manual`, so the AI protects it
 * from then on; an emptied field is removed and its ownership forgotten.
 */
export async function saveTranslationEdits(
  principal: Principal,
  admin: AdminApiContext,
  input: {
    resource: string;
    type: ResourceType;
    locale: string;
    fields: readonly FieldEdit[];
    actor: string | null;
  },
): Promise<EditResult> {
  const { resource, type, locale, fields, actor } = input;
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

/**
 * Translates one resource into the named languages now, through the engine
 * and its ownership rules: a field a person wrote is left alone unless the
 * language's own policy says otherwise.
 */
export async function translateForPerson(
  principal: Principal,
  admin: AdminApiContext,
  input: {
    resource: string;
    type: ResourceType;
    locales: string[];
    mode: SyncMode;
    actor: string | null;
  },
): Promise<EditResult> {
  if (!isConfigured())
    return {
      ok: false,
      message: "AI translation is not configured on this server.",
    };
  if (input.locales.length === 0)
    return { ok: false, message: "Choose a language to translate into." };
  const locales = await listShopLocales(admin);
  const primary =
    locales.kind === "read"
      ? locales.locales.find((l) => l.primary)
      : undefined;
  if (!primary)
    return { ok: false, message: "Languages could not be read from Shopify." };

  const result = await translateResourceNow(principal, admin, {
    resourceId: input.resource,
    resourceType: input.type,
    primaryLocale: primary.locale,
    targetLocales: input.locales,
    mode: input.mode,
    requestedBy: input.actor,
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
