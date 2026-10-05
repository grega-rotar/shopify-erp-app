import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";

import {
  HtmlEditor,
  HtmlPreview,
  HtmlSource,
} from "~/web/components/html-editor";
import { needsSourceEditing } from "~/web/lib/html";
import type { ProductWorkspace } from "~/web/lib/product-workspace.server";
import { localeLabel } from "~/web/lib/translations";

/**
 * This product in every language (docs/translations.md), with the
 * translation engine's own rules: fields a language keeps in the original
 * owe nothing, Shopify says what is outdated, and ownership says who wrote
 * each field.
 *
 * Translating goes through the same engine and provider path as a sync,
 * so a field a person wrote is left alone unless the language's policy
 * says otherwise. Editing one language opens the source beside the
 * translation; saving sends only the fields that were changed, each
 * recorded as a person's, so an untouched AI translation stays the AI's
 * and a person's stays theirs.
 */

type Translations = Extract<ProductWorkspace["translations"], { ok: true }>;
type Language = Translations["languages"][number];

const STATE_TEXT: Record<string, string> = {
  missing: "Missing",
  outdated: "Outdated",
  ai: "AI",
  manual: "Edited by a person",
  existing: "Translated",
  kept: "Kept in original",
};

const MODAL_ID = "product-translation";

type Result = { ok: boolean; message: string };

export function ProductTranslations({
  workspace,
  productId,
  aiConfigured,
}: {
  workspace: ProductWorkspace;
  productId: string;
  aiConfigured: boolean;
}) {
  const translations = workspace.translations;
  const translator = useFetcher<Result>();
  const [editing, setEditing] = useState<string | null>(null);

  useEffect(() => {
    if (
      translator.state === "idle" &&
      translator.data?.ok &&
      typeof shopify !== "undefined"
    )
      shopify.toast.show(translator.data.message);
  }, [translator.state, translator.data]);

  if (!translations.ok)
    return (
      <s-section heading="Translations">
        <s-text color="subdued">{translations.message}</s-text>
      </s-section>
    );

  const { languages, fields, primary } = translations;
  if (languages.length === 0)
    return (
      <s-section heading="Translations">
        <s-stack direction="block" gap="small-300">
          <s-text>{`The store has one language, ${primary.name}.`}</s-text>
          <s-stack direction="inline">
            <s-button href="/app/translations/add">Add a language</s-button>
          </s-stack>
        </s-stack>
      </s-section>
    );

  const busy = translator.state !== "idle";
  const owedLocales = languages
    .filter((l) => l.published && (l.missing > 0 || l.outdated > 0))
    .map((l) => l.locale);
  const translate = (locales: string[], mode: "missing" | "missing_outdated") =>
    translator.submit(
      { intent: "translate", locales: locales.join(","), mode },
      { method: "post" },
    );
  const editingLanguage = languages.find((l) => l.locale === editing) ?? null;

  return (
    <s-stack direction="block" gap="large">
      {translator.data && !translator.data.ok ? (
        <s-banner tone="critical" heading="That did not work">
          <s-paragraph>{translator.data.message}</s-paragraph>
        </s-banner>
      ) : null}

      <s-section heading="Languages">
        <s-stack direction="block" gap="base">
          <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
            <s-text color="subdued">
              {`Written in ${primary.name}. ${
                owedLocales.length === 0
                  ? "Every published language is up to date."
                  : `${owedLocales.length} published ${owedLocales.length === 1 ? "language needs" : "languages need"} work.`
              }`}
            </s-text>
            {aiConfigured && owedLocales.length > 0 ? (
              <s-button
                variant="primary"
                onClick={() => translate(owedLocales, "missing_outdated")}
                {...(busy ? { loading: true, disabled: true } : {})}
              >
                Translate what is missing
              </s-button>
            ) : null}
          </s-grid>

          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">Language</s-table-header>
              <s-table-header listSlot="secondary">In Shopify</s-table-header>
              <s-table-header listSlot="secondary">
                AI translation
              </s-table-header>
              <s-table-header listSlot="kicker">This product</s-table-header>
              <s-table-header>
                <s-text accessibilityVisibility="exclusive">Actions</s-text>
              </s-table-header>
            </s-table-header-row>
            <s-table-body>
              {languages.map((language) => (
                <s-table-row key={language.locale}>
                  <s-table-cell>
                    <s-link
                      href={`/app/translations/languages/${language.locale}`}
                    >
                      {localeLabel(language.locale, language.name)}
                    </s-link>
                  </s-table-cell>
                  <s-table-cell>
                    {language.published ? "Published" : "Unpublished"}
                  </s-table-cell>
                  <s-table-cell>
                    {language.aiEnabled ? "On" : "Off"}
                  </s-table-cell>
                  <s-table-cell>
                    <s-text
                      tone={
                        language.published &&
                        (language.missing > 0 || language.outdated > 0)
                          ? "caution"
                          : "auto"
                      }
                    >
                      {summary(language)}
                    </s-text>
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack
                      direction="inline"
                      gap="small-300"
                      justifyContent="end"
                    >
                      {aiConfigured &&
                      (language.missing > 0 || language.outdated > 0) ? (
                        <s-button
                          variant="tertiary"
                          onClick={() =>
                            translate([language.locale], "missing_outdated")
                          }
                          {...(busy ? { disabled: true } : {})}
                        >
                          Translate
                        </s-button>
                      ) : null}
                      <s-button
                        command="--show"
                        commandFor={MODAL_ID}
                        onClick={() => setEditing(language.locale)}
                      >
                        Edit
                      </s-button>
                    </s-stack>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
          {!aiConfigured ? (
            <s-text color="subdued">
              AI translation is not configured on this server.
            </s-text>
          ) : null}
        </s-stack>
      </s-section>

      <s-section heading="By field">
        <s-table variant="auto">
          <s-table-header-row>
            <s-table-header listSlot="primary">Field</s-table-header>
            {languages.map((language) => (
              <s-table-header key={language.locale} listSlot="secondary">
                {language.name}
              </s-table-header>
            ))}
          </s-table-header-row>
          <s-table-body>
            {fields.map((field) => (
              <s-table-row key={field.key}>
                <s-table-cell>{field.label}</s-table-cell>
                {languages.map((language) => {
                  const state = language.fields[field.key]?.state ?? "missing";
                  return (
                    <s-table-cell key={language.locale}>
                      <s-text
                        color={state === "kept" ? "subdued" : "base"}
                        tone={
                          state === "missing" || state === "outdated"
                            ? "caution"
                            : "auto"
                        }
                      >
                        {STATE_TEXT[state] ?? state}
                      </s-text>
                    </s-table-cell>
                  );
                })}
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
        <s-stack direction="inline" gap="small-300">
          <s-button
            variant="tertiary"
            href={`/app/translations/editor?type=PRODUCT&resource=${encodeURIComponent(productId)}`}
          >
            Open in the translation editor
          </s-button>
        </s-stack>
      </s-section>

      <TranslationModal
        language={editingLanguage}
        fields={fields}
        primaryName={primary.name}
        aiConfigured={aiConfigured}
      />
    </s-stack>
  );
}

function summary(language: Language): string {
  if (language.owed === 0) return "Nothing to translate";
  if (language.missing === 0 && language.outdated === 0) return "Complete";
  const parts = [
    language.missing > 0 ? `${language.missing} missing` : null,
    language.outdated > 0 ? `${language.outdated} outdated` : null,
  ].filter(Boolean);
  return `${language.percent}% · ${parts.join(", ")}`;
}

/**
 * One language's translation of this product, beside the source. The
 * dialog stays mounted — the button that opens it needs it there — and
 * starts from the chosen language's values each time the language changes.
 */
function TranslationModal({
  language,
  fields,
  primaryName,
  aiConfigured,
}: {
  language: Language | null;
  fields: Translations["fields"];
  primaryName: string;
  aiConfigured: boolean;
}) {
  const saver = useFetcher<Result>();
  const translator = useFetcher<Result>();
  const initial = Object.fromEntries(
    fields.map((field) => [
      field.key,
      language?.fields[field.key]?.value ?? "",
    ]),
  );
  const [values, setValues] = useState<Record<string, string>>(initial);
  const latest = useRef(initial);
  latest.current = initial;
  // One dialog for every language: choosing another starts from its values.
  const locale = language?.locale ?? null;
  useEffect(() => {
    setValues(latest.current);
  }, [locale]);
  const changed = fields.filter(
    (field) => (values[field.key] ?? "") !== (initial[field.key] ?? ""),
  );
  const busy = saver.state !== "idle" || translator.state !== "idle";

  useEffect(() => {
    if (saver.state !== "idle" || !saver.data?.ok) return;
    if (typeof shopify !== "undefined") shopify.toast.show(saver.data.message);
    const modal = document.getElementById(MODAL_ID) as {
      hideOverlay?: () => void;
    } | null;
    modal?.hideOverlay?.();
  }, [saver.state, saver.data]);

  // After the AI has written, the dialog starts again from what Shopify now holds.
  useEffect(() => {
    if (translator.state !== "idle" || !translator.data?.ok) return;
    setValues(latest.current);
    if (typeof shopify !== "undefined")
      shopify.toast.show(translator.data.message);
  }, [translator.state, translator.data]);

  const heading = language ? `${language.name} translation` : "Translation";
  const failure =
    (saver.data && !saver.data.ok ? saver.data.message : null) ??
    (translator.data && !translator.data.ok ? translator.data.message : null);

  return (
    <s-modal id={MODAL_ID} heading={heading} size="large">
      {language ? (
        <s-stack direction="block" gap="base">
          {failure ? (
            <s-banner tone="critical">
              <s-paragraph>{failure}</s-paragraph>
            </s-banner>
          ) : null}
          <s-text color="subdued">
            {`${primaryName} on the left. What you save here is recorded as edited by a person, and AI translation leaves it alone.`}
          </s-text>
          {fields.map((field) => {
            const state = language.fields[field.key]?.state ?? "missing";
            const html = field.type === "HTML";
            const rawOnly = html && needsSourceEditing(field.source);
            const value = values[field.key] ?? "";
            const set = (next: string) =>
              setValues((current) => ({ ...current, [field.key]: next }));
            return (
              <s-stack key={field.key} direction="block" gap="small-300">
                <s-stack direction="inline" gap="small-300" alignItems="center">
                  <s-text type="strong">{field.label}</s-text>
                  <s-text color="subdued">{STATE_TEXT[state] ?? state}</s-text>
                </s-stack>
                <s-query-container>
                  <s-grid
                    gridTemplateColumns="@container (inline-size <= 640px) 1fr, 'minmax(0, 1fr) minmax(0, 1fr)'"
                    gap="base"
                    alignItems="start"
                  >
                    {html ? (
                      rawOnly ? (
                        <HtmlSource
                          html={field.source}
                          blockSize="240px"
                          label={`${field.label}, ${primaryName}`}
                        />
                      ) : (
                        <HtmlPreview
                          html={field.source}
                          blockSize="240px"
                          label={`${field.label}, ${primaryName}`}
                        />
                      )
                    ) : (
                      <s-box
                        padding="small-300"
                        background="subdued"
                        borderRadius="base"
                      >
                        <s-text>{field.source}</s-text>
                      </s-box>
                    )}
                    {state === "kept" ? (
                      <s-text color="subdued">
                        Kept in the original in this language.
                      </s-text>
                    ) : html && !rawOnly ? (
                      <HtmlEditor
                        label={`${field.label}, ${language.name}`}
                        value={value}
                        onChange={set}
                        blockSize="240px"
                        placeholder={`${field.label} in ${language.name}`}
                        busy={busy}
                      />
                    ) : html || field.source.length > 120 ? (
                      <s-text-area
                        label={`${field.label}, ${language.name}`}
                        labelAccessibilityVisibility="exclusive"
                        rows={html ? 10 : 3}
                        value={value}
                        onInput={(event) => set(event.currentTarget.value)}
                      />
                    ) : (
                      <s-text-field
                        label={`${field.label}, ${language.name}`}
                        labelAccessibilityVisibility="exclusive"
                        value={value}
                        onInput={(event) => set(event.currentTarget.value)}
                      />
                    )}
                  </s-grid>
                </s-query-container>
              </s-stack>
            );
          })}
        </s-stack>
      ) : null}

      <s-button
        slot="primary-action"
        variant="primary"
        {...(changed.length === 0 || busy ? { disabled: true } : {})}
        {...(saver.state !== "idle" ? { loading: true } : {})}
        onClick={() => {
          if (!language) return;
          saver.submit(
            {
              intent: "save-translation",
              form: JSON.stringify({
                locale: language.locale,
                fields: changed.map((field) => ({
                  key: field.key,
                  value: values[field.key] ?? "",
                  digest: field.digest,
                })),
              }),
            },
            { method: "post" },
          );
        }}
      >
        {changed.length > 1 ? `Save ${changed.length} fields` : "Save"}
      </s-button>
      {aiConfigured &&
      language &&
      (language.missing > 0 || language.outdated > 0) ? (
        <s-button
          slot="secondary-actions"
          {...(changed.length > 0 || busy ? { disabled: true } : {})}
          onClick={() =>
            translator.submit(
              {
                intent: "translate",
                locales: language.locale,
                mode: "missing_outdated",
              },
              { method: "post" },
            )
          }
        >
          Translate what is missing
        </s-button>
      ) : null}
      <s-button slot="secondary-actions" command="--hide" commandFor={MODAL_ID}>
        Close
      </s-button>
    </s-modal>
  );
}
