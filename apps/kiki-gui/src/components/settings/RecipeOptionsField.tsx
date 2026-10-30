import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { RecipeOption, RecipeOptionValues } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Toggle, type Feedback } from '../controls';

export function RecipeOptionsField({ recipe, sourceFile, values, options, disabled = false, onChange }: {
  recipe: string | undefined;
  sourceFile?: string;
  values?: RecipeOptionValues;
  options?: readonly RecipeOption[];
  disabled?: boolean;
  onChange: (values: RecipeOptionValues) => void | Promise<void>;
}) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const id = useId();
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const selected = recipe !== undefined && recipe !== 'off';
  const sourcePath = sourceFile?.replaceAll('\\', '/');
  const relativeFile = recipe !== undefined && !/^(?:[a-z][a-z0-9+.-]*:|\/|~)/iu.test(recipe) && (recipe.startsWith('.') || /[\\/]|\.toml$/iu.test(recipe));
  const locator = relativeFile && sourcePath !== undefined ? `${sourcePath.slice(0, sourcePath.lastIndexOf('/') + 1)}${recipe}` : recipe;
  const query = useQuery({
    queryKey: ['recipe-options', locator],
    queryFn: () => client.getRecipe(locator!),
    enabled: selected && options === undefined,
    retry: false,
  });
  if (!selected) return null;
  const definitions = options ?? query.data?.resolved.options ?? [];
  if (query.isError && options === undefined) return <FeedbackLine feedback={{ tone: 'error', text: errorText(locale, query.error) }} />;
  if (definitions.length === 0) return null;
  return <fieldset className="min-w-0 space-y-2" disabled={disabled || saving} data-recipe-options>
    <legend className="mb-1 text-[12px] font-medium text-ink-soft">{t('st.recipe.options')}</legend>
    {definitions.map((option) => <div key={option.id} className="space-y-0.5" data-recipe-option={option.id}>
      <Toggle id={`${id}-${option.id}`} layout="row" label={option.name} checked={values?.[option.id] ?? option.default} disabled={disabled || saving}
        onChange={(checked) => {
          setSaving(true); setFeedback(null);
          void Promise.resolve().then(() => onChange({ ...values, [option.id]: checked })).catch((error: unknown) => {
            setFeedback({ tone: 'error', text: errorText(locale, error) });
          }).finally(() => { setSaving(false); });
        }} />
      {option.description === undefined ? null : <p className="text-[11.5px] leading-5 text-ink-faint">{option.description}</p>}
    </div>)}
    <FeedbackLine feedback={feedback} />
  </fieldset>;
}
