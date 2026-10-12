/**
 * A settings property's own text, in the reader's language.
 *
 * A manifest may translate any of the three text fields a settings property
 * carries — `title`, `description`, `groupTitle` — and it may translate one
 * field, one language, or nothing at all. Each field falls back to the
 * untranslated string beside it, which is the rule the marketplace catalog
 * already uses for its entries (`localizeEntry`): a package that never
 * translated anything reads exactly as its author wrote it, and a label is
 * never a bare settings key.
 *
 * Both settings routes resolve text through here — the generic schema form and
 * the media source form — so there is one fallback rule, not one per form.
 */

/** One language's text for a settings property. Every field is optional. */
export interface SettingText {
  readonly title?: string;
  readonly description?: string;
  readonly groupTitle?: string;
}

/** A settings property as its manifest declares it: the text, plus its per-language spellings. */
export interface SettingTextSource extends SettingText {
  /** Per-language text, keyed by language tag (`zh`, `zh-Hans`, …). */
  readonly localizations?: Readonly<Record<string, SettingText>>;
}

/**
 * A language tag's entry: the exact tag first, then any tag of the same
 * primary language, so a manifest that writes `zh-Hans` still answers a `zh`
 * reader. `undefined` means the property is untranslated for this reader.
 */
function localizationOf(localizations: SettingTextSource['localizations'], locale: string): SettingText | undefined {
  if (localizations === undefined) return undefined;
  const exact = localizations[locale];
  if (exact !== undefined) return exact;
  const primary = locale.split('-')[0]!.toLowerCase();
  for (const [tag, text] of Object.entries(localizations)) {
    if (tag.toLowerCase().split('-')[0] === primary) return text;
  }
  return undefined;
}

/** The property's own text for `locale`, field by field. */
export function localizeSettingText(property: SettingTextSource, locale: string): SettingText {
  const localized = localizationOf(property.localizations, locale);
  return {
    title: localized?.title ?? property.title,
    description: localized?.description ?? property.description,
    groupTitle: localized?.groupTitle ?? property.groupTitle,
  };
}
