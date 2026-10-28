import { useState } from 'react';
import type { NotificationChannel, NotificationSettings } from '@kiki/klient';

import { useI18n } from '../../../i18n';
import { FeedbackLine, SaveStatus } from '../../controls';
import { SectionCard } from '../SectionCard';
import { useInstantSave } from '../useInstantSave';
import { providerLabel, sortedChannels } from './model';
import { useNotificationWrites } from './useNotifications';

export const NOTIFY_SCENES = ['work_complete', 'question_pending'] as const;
type Scene = (typeof NOTIFY_SCENES)[number];

/**
 * Which push channel hears which moment, as one table: a row per channel, a
 * column per moment. This is the only place a channel's moments are chosen,
 * so "when" lives with the other rules and a channel's own page stays about
 * how to reach it. Each box saves itself.
 */
export function SceneMatrix({ settings }: { settings: NotificationSettings }) {
  const { t } = useI18n();
  const { api, apply } = useNotificationWrites();
  const save = useInstantSave();
  const [pending, setPending] = useState<string | null>(null);
  const channels = sortedChannels(settings);

  const nameOf = (channel: NotificationChannel) => {
    const instance = settings.provider_instances[channel.provider_instance_id];
    return channel.label ?? instance?.label ?? providerLabel(t, instance?.provider_id ?? '');
  };
  const write = (id: string, channel: NotificationChannel, scene: Scene, on: boolean) => {
    setPending(`${id}.${scene}`);
    const { health: _health, ...persisted } = channel;
    void save.run(async () => {
      apply(await api.upsertChannel(id, { ...persisted, scenes: { ...channel.scenes, [scene]: on } }));
    });
  };

  return (
    <SectionCard id="st-card-notify-scenes" title={t('st.notify.matrixTitle')}>
      {channels.length === 0 ? (
        <p className="text-[13px] text-ink-soft" data-notify-matrix-empty>{t('st.notify.matrixEmpty')}</p>
      ) : (
        <div className={`min-w-0 ${settings.global.enabled ? '' : 'opacity-60'}`}>
          <table className="w-full table-fixed border-collapse text-[13px]" data-notify-matrix>
            <thead>
              <tr className="border-b border-hairline text-left text-[12px] text-ink-soft">
                <th scope="col" className="py-2 pr-3 font-normal">{t('st.notify.matrixChannel')}</th>
                {NOTIFY_SCENES.map((scene) => (
                  <th key={scene} scope="col" className="w-[30%] px-2 py-2 text-center font-normal leading-4 max-sm:w-[34%]">
                    {t(`st.notify.scene.${scene}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {channels.map(([id, channel]) => (
                <tr key={id} data-notify-matrix-row={id} className="border-b border-hairline last:border-b-0">
                  <th scope="row" className="py-1.5 pr-3 text-left font-normal">
                    <span className={`block truncate ${channel.enabled ? 'text-ink' : 'text-ink-faint'}`}>{nameOf(channel)}</span>
                  </th>
                  {NOTIFY_SCENES.map((scene) => (
                    <td key={scene} className="px-2 py-1.5 text-center">
                      <label className="inline-flex min-h-10 min-w-10 cursor-pointer items-center justify-center gap-1.5">
                        <input type="checkbox" data-notify-scene={scene} data-notify-scene-channel={id}
                          className="h-4 w-4 accent-[var(--color-selected-ink)]"
                          aria-label={t('st.notify.matrixCell', { channel: nameOf(channel), scene: t(`st.notify.scene.${scene}`) })}
                          checked={channel.scenes[scene]} disabled={save.saving}
                          onChange={(event) => { write(id, channel, scene, event.target.checked); }} />
                        {pending === `${id}.${scene}` ? <SaveStatus saving={save.saving} saved={save.saved} /> : null}
                      </label>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <FeedbackLine feedback={save.error} />
        </div>
      )}
    </SectionCard>
  );
}
