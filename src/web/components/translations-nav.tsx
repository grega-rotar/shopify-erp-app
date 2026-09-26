import {
  TRANSLATIONS_SECTIONS,
  type TranslationsSection,
} from "~/web/lib/translations";

/**
 * The Translations area's own navigation: six destinations, always visible,
 * the current one stated rather than linked (docs/translations.md § Screens).
 * The same shape as product setup's, because two areas with sections should
 * read the same way.
 */
export function TranslationsNav({ current }: { current: TranslationsSection }) {
  return (
    /*
     * A row of tabs, the way the admin's own index pages switch views: the
     * current section drawn as the pressed one, the others as quiet
     * buttons. Buttons with addresses, so each is still a place.
     */
    <s-box
      paddingBlockEnd="small-300"
      borderWidth="none none small none"
      borderStyle="none none solid none"
      borderColor="subdued"
      accessibilityRole="navigation"
      accessibilityLabel="Translations sections"
    >
      <s-stack direction="inline" gap="small-400" alignItems="center">
        {TRANSLATIONS_SECTIONS.map((section) =>
          section.key === current ? (
            <s-button
              key={section.key}
              variant="secondary"
              accessibilityLabel={`${section.label}, current section`}
            >
              {section.label}
            </s-button>
          ) : (
            <s-button key={section.key} variant="tertiary" href={section.href}>
              {section.label}
            </s-button>
          ),
        )}
      </s-stack>
    </s-box>
  );
}
