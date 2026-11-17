/**
 * ModelPicker — shared single- and multi-value model picker built on
 * `SearchableSelect` and `buildCatalogModelOptions`.
 *
 * Groups catalog models by provider, surfaces decision facts as badges, supports
 * an optional unset/default row and `inherit` row, and preserves model IDs that
 * are absent from the catalog as visible "not in catalog" entries so opening and
 * saving a configuration never drops unknown or external-engine IDs.
 */

import { useCallback, useMemo, type ReactNode } from 'react';
import type { ModelCatalogItem } from '@kiki/protocol';

import { useI18n } from '../i18n';
import { buildCatalogModelOptions, useProviderGroupLabel } from './modelSelectOptions';
import { SearchableSelect, type SearchableSelectOption } from './SearchableSelect';
import { FORM_SELECT_TRIGGER } from './settings/SettingsPrimitives';

type Translate = ReturnType<typeof useI18n>['t'];

const EMPTY_CATALOG_MODELS: readonly ModelCatalogItem[] = [];
const EMPTY_SELECT_OPTIONS: readonly SearchableSelectOption[] = [];

export function buildModelPickerOptions(
  models: readonly ModelCatalogItem[],
  t: Translate,
  {
    allowInherit = false,
    unsetLabel,
    unsetDescription,
    unsetGroup,
    unsetKeywords,
    groupLabel,
    currentId,
    preserveValues = [],
  }: {
    readonly allowInherit?: boolean;
    readonly unsetLabel?: string;
    readonly unsetDescription?: string;
    readonly unsetGroup?: string;
    readonly unsetKeywords?: string;
    readonly groupLabel?: (providerId: string) => string;
    readonly currentId?: string;
    readonly preserveValues?: readonly string[];
  } = {},
): SearchableSelectOption[] {
  const catalogOptions = buildCatalogModelOptions(models, t, { groupLabel, currentId });
  const known = new Set<string>(catalogOptions.map((option) => option.value));
  if (unsetLabel !== undefined) known.add('');
  if (allowInherit) known.add('inherit');

  const missingOptions: SearchableSelectOption[] = [];
  for (const raw of preserveValues) {
    const id = raw.trim();
    if (id === '' || known.has(id)) continue;
    known.add(id);
    missingOptions.push({
      value: id,
      label: id,
      badges: [{ label: t('st.profiles.aliasMissingShort'), tone: 'caution' }],
      title: t('st.profiles.aliasMissingTitle', { alias: id }),
      keywords: id,
    });
  }

  return [
    ...(unsetLabel === undefined ? [] : [{
      value: '',
      label: unsetLabel,
      description: unsetDescription,
      group: unsetGroup,
      keywords: unsetKeywords,
    }]),
    ...(allowInherit ? [{
      value: 'inherit',
      label: t('st.namedAgents.followCallerModel'),
      description: t('st.namedAgents.followCallerModelHint'),
    }] : []),
    ...missingOptions,
    ...catalogOptions,
  ];
}

export interface ModelPickerBaseProps {
  readonly id?: string;
  readonly models?: readonly ModelCatalogItem[];
  /** Explicit option rows when a surface augments or replaces the catalog list (e.g. composer projections, external engines, or hybrid decision sources). */
  readonly options?: readonly SearchableSelectOption[];
  readonly allowInherit?: boolean;
  readonly allowCustomValue?: boolean;
  readonly customValueLabel?: (value: string) => string;
  readonly disabled?: boolean;
  readonly missing?: boolean;
  /** Label for the empty value `""` when an unset/default row should be shown. */
  readonly unsetLabel?: string;
  readonly unsetDescription?: string;
  readonly unsetGroup?: string;
  readonly unsetKeywords?: string;
  /** Trigger content while unset (e.g. an inherited value, muted). */
  readonly unsetTrigger?: ReactNode;
  readonly emptyText?: string;
  readonly ariaLabel?: string;
  readonly ariaLabelledBy?: string;
  readonly ariaInvalid?: boolean;
  readonly ariaDescribedBy?: string;
  readonly title?: string;
  readonly searchPlaceholder?: string;
  readonly rootClassName?: string;
  readonly buttonClassName?: string;
  readonly labelClassName?: string;
  readonly panelClassName?: string;
  readonly panelHeader?: ReactNode;
  readonly panelFooter?: ReactNode;
  readonly triggerData?: Readonly<Record<string, string | boolean | undefined>>;
  readonly panelData?: Readonly<Record<string, string | boolean | undefined>>;
  readonly triggerLabel?: ReactNode;
  readonly triggerIcon?: ReactNode;
  readonly triggerSuffix?: ReactNode;
  readonly hideChevron?: boolean;
  readonly hideFilter?: boolean;
  readonly align?: 'start' | 'end';
  readonly placement?: 'below' | 'above' | 'auto';
  readonly density?: 'comfortable' | 'compact';
  readonly openSignal?: number;
  readonly closeSignal?: number;
  readonly currentId?: string;
  /** Use exact alias as the trigger label in single mode (profile editor convention). */
  readonly rawAliasTrigger?: boolean;
}

export interface SingleModelPickerProps extends ModelPickerBaseProps {
  readonly multiple?: false;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly values?: never;
}

export interface MultiModelPickerProps extends ModelPickerBaseProps {
  readonly multiple: true;
  readonly values: readonly string[];
  readonly onChange: (values: string[]) => void;
  readonly value?: never;
}

export type ModelPickerProps = SingleModelPickerProps | MultiModelPickerProps;

export function ModelPicker(props: ModelPickerProps) {
  const {
    id,
    models = EMPTY_CATALOG_MODELS,
    options: explicitOptions,
    allowInherit = false,
    allowCustomValue = true,
    customValueLabel,
    disabled = false,
    missing,
    unsetLabel,
    unsetDescription,
    unsetGroup,
    unsetKeywords,
    unsetTrigger,
    emptyText,
    ariaLabel,
    ariaLabelledBy,
    ariaInvalid,
    ariaDescribedBy,
    title,
    searchPlaceholder,
    rootClassName,
    buttonClassName,
    labelClassName,
    panelClassName,
    panelHeader,
    panelFooter,
    triggerData,
    panelData,
    triggerLabel,
    triggerIcon,
    triggerSuffix,
    hideChevron,
    hideFilter,
    align,
    placement,
    density,
    openSignal,
    closeSignal,
    currentId,
    rawAliasTrigger = false,
  } = props;
  const { t } = useI18n();
  const groupLabel = useProviderGroupLabel();
  const isMultiple = props.multiple === true;

  const preserveValues = useMemo(
    () => (isMultiple ? props.values : (props.value !== '' ? [props.value] : [])),
    [isMultiple, props.value, props.values],
  );

  const catalogOptions = useMemo(
    () => (explicitOptions !== undefined
      ? EMPTY_SELECT_OPTIONS
      : buildCatalogModelOptions(models, t, { groupLabel, currentId })),
    [explicitOptions, models, t, groupLabel, currentId],
  );

  const catalogKnownIds = useMemo(
    () => (explicitOptions !== undefined ? undefined : new Set(catalogOptions.map((option) => option.value))),
    [explicitOptions, catalogOptions],
  );

  const options = useMemo(() => {
    if (explicitOptions !== undefined) return explicitOptions;
    const known = new Set<string>(catalogKnownIds);
    if (unsetLabel !== undefined) known.add('');
    if (allowInherit) known.add('inherit');

    const missingOptions: SearchableSelectOption[] = [];
    for (const raw of preserveValues) {
      const idVal = raw.trim();
      if (idVal === '' || known.has(idVal)) continue;
      known.add(idVal);
      missingOptions.push({
        value: idVal,
        label: idVal,
        badges: [{ label: t('st.profiles.aliasMissingShort'), tone: 'caution' }],
        title: t('st.profiles.aliasMissingTitle', { alias: idVal }),
        keywords: idVal,
      });
    }

    if (unsetLabel === undefined && !allowInherit && missingOptions.length === 0) {
      return catalogOptions;
    }

    return [
      ...(unsetLabel === undefined ? [] : [{
        value: '',
        label: unsetLabel,
        description: unsetDescription,
        group: unsetGroup,
        keywords: unsetKeywords,
      }]),
      ...(allowInherit ? [{
        value: 'inherit',
        label: t('st.namedAgents.followCallerModel'),
        description: t('st.namedAgents.followCallerModelHint'),
      }] : []),
      ...missingOptions,
      ...catalogOptions,
    ];
  }, [explicitOptions, catalogOptions, catalogKnownIds, t, allowInherit, unsetLabel, unsetDescription, unsetGroup, unsetKeywords, preserveValues]);

  const hasMissingSelection = useMemo(() => {
    if (missing !== undefined) return missing;
    if (explicitOptions !== undefined || models.length === 0 || catalogKnownIds === undefined) return false;
    return preserveValues.some((val) => val !== '' && val !== 'inherit' && !catalogKnownIds.has(val));
  }, [missing, explicitOptions, models.length, catalogKnownIds, preserveValues]);

  const resolvedSuffix = triggerSuffix ?? (
    hasMissingSelection
      ? <span data-alias-missing className="shrink-0 text-[11px] text-amber-ink">{t('st.profiles.aliasMissingShort')}</span>
      : undefined
  );

  const resolvedClassName = buttonClassName
    ?? `${FORM_SELECT_TRIGGER} ${hasMissingSelection ? 'border-amber-ink/50' : ''}`;

  const defaultCustomLabel = useCallback((val: string) => t('select.useCustom', { value: val }), [t]);
  const customLabel = customValueLabel ?? defaultCustomLabel;
  const resolvedTriggerData = useMemo(
    () => ({ 'data-model-picker': '', ...triggerData }),
    [triggerData],
  );

  if (props.multiple) {
    return (
      <SearchableSelect
        multiple
        id={id}
        options={options}
        values={props.values}
        onChange={props.onChange}
        disabled={disabled}
        allowCustomValue={allowCustomValue}
        customValueLabel={customLabel}
        hideFilter={hideFilter}
        emptyText={emptyText ?? unsetLabel}
        ariaLabel={ariaLabel ?? (ariaLabelledBy === undefined ? t('usage.governance.models') : undefined)}
        ariaLabelledBy={ariaLabelledBy}
        ariaInvalid={ariaInvalid}
        ariaDescribedBy={ariaDescribedBy}
        title={title}
        searchPlaceholder={searchPlaceholder ?? t('st.models.searchPlaceholder')}
        triggerLabel={triggerLabel ?? (props.values.length === 0 ? unsetTrigger : undefined)}
        triggerIcon={triggerIcon}
        triggerSuffix={resolvedSuffix}
        hideChevron={hideChevron}
        rootClassName={rootClassName}
        buttonClassName={resolvedClassName}
        labelClassName={labelClassName}
        panelClassName={panelClassName}
        panelHeader={panelHeader}
        panelFooter={panelFooter}
        triggerData={resolvedTriggerData}
        panelData={panelData}
        align={align}
        placement={placement}
        density={density}
        openSignal={openSignal}
        closeSignal={closeSignal}
      />
    );
  }

  const resolvedSingleTrigger = triggerLabel ?? (
    rawAliasTrigger
      ? (props.value !== '' && props.value !== 'inherit' ? props.value : props.value === '' ? unsetTrigger : undefined)
      : (props.value === '' ? unsetTrigger : undefined)
  );

  return (
    <SearchableSelect
      id={id}
      options={options}
      value={props.value}
      onChange={props.onChange}
      disabled={disabled}
      allowCustomValue={allowCustomValue}
      customValueLabel={customLabel}
      hideFilter={hideFilter}
      emptyText={emptyText ?? unsetLabel}
      ariaLabel={ariaLabel ?? (ariaLabelledBy === undefined ? t('st.profiles.model') : undefined)}
      ariaLabelledBy={ariaLabelledBy}
      ariaInvalid={ariaInvalid}
      ariaDescribedBy={ariaDescribedBy}
      title={title}
      searchPlaceholder={searchPlaceholder ?? t('st.models.searchPlaceholder')}
      triggerLabel={resolvedSingleTrigger}
      triggerIcon={triggerIcon}
      triggerSuffix={resolvedSuffix}
      hideChevron={hideChevron}
      rootClassName={rootClassName}
      buttonClassName={resolvedClassName}
      labelClassName={labelClassName}
      panelClassName={panelClassName}
      panelHeader={panelHeader}
      panelFooter={panelFooter}
      triggerData={resolvedTriggerData}
      panelData={panelData}
      align={align}
      placement={placement}
      density={density}
      openSignal={openSignal}
      closeSignal={closeSignal}
    />
  );
}
