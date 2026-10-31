import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { RecipeOption, RecipeOptionValues } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';
import { useI18n } from '../../i18n';
import { recipeDiagnosticText } from '../../lib/recipes';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Toggle, type Feedback } from '../controls';
import { SettingField, SettingsBox } from './fields';

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
    queryKey: ['recipe-options', locator, values],
    queryFn: async () => {
      const detail = values === undefined ? await client.getRecipe(locator!) : await client.getRecipe(locator!, values);
      return detail ?? null;
    },
    enabled: selected && options === undefined,
    retry: false,
  });
  if (!selected) return null;
  const recipeReference = recipe;
  const definitions = options ?? query.data?.resolved.options ?? [];
  const diagnostics = options === undefined ? query.data?.resolved.diagnostics ?? [] : [];
  const diagnosticLines = diagnostics.map((diagnostic, index) => (
    <FeedbackLine key={`${diagnostic.code}-${index}`} feedback={{ tone: 'error', text: `${recipeReference}: ${recipeDiagnosticText(diagnostic)}` }} />
  ));
  if (query.isError && options === undefined) {
    return <FeedbackLine feedback={{ tone: 'error', text: `${recipeReference}: ${errorText(locale, query.error)}` }} />;
  }
  if (query.data === null && options === undefined) {
    return <FeedbackLine feedback={{ tone: 'error', text: `${recipeReference}: ${t('st.recipe.dangling')}` }} />;
  }
  if (definitions.length === 0) {
    return diagnostics.length === 0 ? null : <div data-recipe-options-diagnostics>{diagnosticLines}</div>;
  }
  return <fieldset className="min-w-0" disabled={disabled || saving} data-recipe-options>
    <legend className="text-[13px] font-medium text-ink">{t('st.recipe.options')}</legend>
    <SettingsBox>
      {definitions.map((option) => <div key={option.id} data-recipe-option={option.id}>
        <SettingField label={option.name} htmlFor={`${id}-${option.id}`} help={option.description}>
          <Toggle id={`${id}-${option.id}`} layout="bare" label={option.name} checked={values?.[option.id] ?? option.default} disabled={disabled || saving}
            onChange={(checked) => {
              setSaving(true); setFeedback(null);
              void Promise.resolve().then(() => onChange({ ...values, [option.id]: checked })).catch((error: unknown) => {
                setFeedback({ tone: 'error', text: errorText(locale, error) });
              }).finally(() => { setSaving(false); });
            }} />
        </SettingField>
      </div>)}
    </SettingsBox>
    {diagnostics.length === 0 ? null : <div data-recipe-options-diagnostics>{diagnosticLines}</div>}
    <FeedbackLine feedback={feedback} />
  </fieldset>;
}
