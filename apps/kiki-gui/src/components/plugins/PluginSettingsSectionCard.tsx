/**
 * PluginSettingsSectionCard — E12 Slot 5 (`settings-section`).
 *
 * Declarative settings section cards contributed by active plugins. Reuses
 * Kiki's flat hairline `SectionCard` grammar (never a nested box-in-box) with a
 * single-line subtitle and a quiet link to the contributing plugin's settings.
 */

import { Link } from 'react-router-dom';

import type { PluginGuiSlotContribution } from '@kiki/protocol';
import {
  resolvePluginLocalizedText,
  selectSettingsSectionSlots,
  type PluginSettingsSectionSlotContribution,
} from '@kiki/session-core';
import { pluginSettingsPath } from '@kiki/session-core/settings';

import { useI18n } from '../../i18n';
import { LINK_CLASS } from '../capabilities/CapabilityLink';
import { Icon } from '../icons';
import { SectionCard } from '../settings/SectionCard';
import { usePluginGuiSlots } from './PluginComposerSlots';

export function PluginSettingsSectionCard({
  slot,
}: {
  readonly slot: PluginSettingsSectionSlotContribution;
}) {
  const { t, locale } = useI18n();
  const title = resolvePluginLocalizedText(slot.title, locale);
  const subtitle =
    slot.subtitle === undefined ? undefined : resolvePluginLocalizedText(slot.subtitle, locale);
  const cardId = `st-card-plugin-slot-${slot.pluginId}-${slot.id}`;

  return (
    <SectionCard
      id={cardId}
      title={title}
      aside={subtitle}
      actions={(
        <Link
          to={pluginSettingsPath(slot.pluginId)}
          data-plugin-settings-slot-link={`${slot.pluginId}:${slot.id}`}
          className={LINK_CLASS}
        >
          {t('pluginSlot.openSettings')}
          <Icon name="arrowRight" size={14} />
        </Link>
      )}
    />
  );
}

export function PluginSettingsSectionSlotList({
  slots,
  workspaceId,
}: {
  readonly slots?: readonly PluginGuiSlotContribution[];
  readonly workspaceId?: string;
}) {
  const queried = usePluginGuiSlots({ workspaceId });
  const sections = selectSettingsSectionSlots(slots ?? queried.slots);
  if (sections.length === 0) return null;

  return (
    <>
      {sections.map((section) => (
        <PluginSettingsSectionCard
          key={`${section.pluginId}:${section.id}`}
          slot={section}
        />
      ))}
    </>
  );
}
