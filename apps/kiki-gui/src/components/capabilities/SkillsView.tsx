/**
 * Skills — built to hold a hundred. The search field and a compact source
 * filter share one line and stay put; below, skills group by where they come
 * from. Every group folds (built-in starts folded under All) and shows its
 * first GROUP_PREVIEW skills until "Show all". Rows are dense single lines:
 * name, the slash command when there is one, and the description; a row
 * opens its SKILL.md in the preview panel. Groups past the viewport skip
 * layout and paint (`content-visibility: auto`), so a long catalog renders
 * in segments without a virtual list.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import type { SkillDescriptor } from '@kiki/protocol';

import { useI18n } from '../../i18n';
import { groupSkills, type SkillGroupId } from '../../lib/capabilities';
import { useConnection } from '../../state/connection';
import { InlineError } from '../controls';
import { Icon } from '../icons';
import { useMediaPreview } from '../mediaPreviewContext';
import { EmptyNote, QUIET_BUTTON, SearchField, Tag } from './primitives';

/** Skills a group shows before "Show all". */
export const GROUP_PREVIEW = 8;

const GROUP_TITLE_KEYS = {
  plugin: 'cap.group.plugin',
  project: 'cap.group.project',
  user: 'cap.group.user',
  extra: 'cap.group.extra',
  builtin: 'cap.group.builtin',
  other: 'cap.group.other',
} as const;

const SOURCE_LABEL_KEYS = {
  plugin: 'cap.skills.source.plugin',
  project: 'cap.skills.source.project',
  user: 'cap.skills.source.user',
  extra: 'cap.skills.source.extra',
  builtin: 'cap.skills.source.builtin',
  other: 'cap.skills.source.other',
} as const;

/** Folded until opened, when nothing narrows the list. */
const START_FOLDED: ReadonlySet<SkillGroupId> = new Set(['builtin']);

export function SkillsView({
  workspaceId,
  onOpenPlugin,
}: {
  readonly workspaceId: string;
  /** Plugin-sourced skills link to their plugin when the host can show it. */
  readonly onOpenPlugin?: (pluginId: string) => void;
}) {
  const { client } = useConnection();
  const { t, tp } = useI18n();
  const preview = useMediaPreview();
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<'all' | SkillGroupId>('all');
  // Explicit user choices; absent means "the default for this group".
  const [folded, setFolded] = useState<ReadonlyMap<SkillGroupId, boolean>>(new Map());
  const [expanded, setExpanded] = useState<ReadonlySet<SkillGroupId>>(new Set());
  const skillsQuery = useQuery({
    queryKey: ['workspace-skills', workspaceId],
    queryFn: () => client.listWorkspaceSkills(workspaceId),
    enabled: workspaceId !== '',
    staleTime: 60_000,
  });
  const allSkills = skillsQuery.data?.skills;
  const allGroups = useMemo(() => groupSkills(allSkills ?? [], ''), [allSkills]);
  const groups = useMemo(
    () => groupSkills(allSkills ?? [], query).filter((group) => source === 'all' || group.id === source),
    [allSkills, query, source],
  );
  const searching = query.trim() !== '';
  const narrowed = searching || source !== 'all';
  const total = allSkills?.length ?? 0;
  const shown = groups.reduce((sum, group) => sum + group.skills.length, 0);

  const isFolded = (id: SkillGroupId) => (narrowed ? false : folded.get(id) ?? START_FOLDED.has(id));
  const toggleFold = (id: SkillGroupId) => {
    setFolded((current) => new Map(current).set(id, !isFolded(id)));
  };
  const open = (skill: SkillDescriptor) => {
    if (skill.source === 'builtin') preview?.openBuiltinSkill(skill.name);
    else preview?.openFile(skill.path);
  };

  return (
    <div className="min-w-0 space-y-5" data-skills-view>
      <div className="flex flex-col gap-2 min-[720px]:flex-row min-[720px]:items-center">
        <div className="min-w-0 flex-1">
          <SearchField value={query} onChange={setQuery} placeholder={t('cap.skills.searchCount', { count: total })} ariaLabel={t('cap.skills.search')} />
        </div>
        {allGroups.length > 1 ? (
          <label className="flex h-10 shrink-0 items-center gap-2 rounded-[10px] bg-ink/[0.04] pl-3 pr-2 text-[13px] text-ink-soft focus-within:ring-1 focus-within:ring-hairline-strong">
            <span className="text-ink-faint">{t('cap.skills.sourceFilter')}</span>
            <select
              value={source}
              onChange={(event) => { setSource(event.target.value as 'all' | SkillGroupId); }}
              data-skills-source={source}
              className="min-w-0 cursor-pointer bg-transparent pr-1 text-[13px] font-medium text-ink outline-none"
            >
              <option value="all">{t('cap.skills.sourceAll')} · {total}</option>
              {allGroups.map((group) => (
                <option key={group.id} value={group.id}>{t(SOURCE_LABEL_KEYS[group.id])} · {group.skills.length}</option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {searching && allSkills !== undefined ? (
        <p className="text-[12px] text-ink-faint tabular-nums" role="status" data-skills-result-count>
          {tp('cap.skills.matches', shown, { total })}
        </p>
      ) : null}

      {workspaceId === '' ? (
        <EmptyNote title={t('cap.noWorkspace')} />
      ) : skillsQuery.isPending ? (
        <p className="text-[13px] text-ink-faint" role="status">{t('cap.loadingSkills')}</p>
      ) : skillsQuery.isError ? (
        <InlineError error={skillsQuery.error} />
      ) : groups.length === 0 ? (
        <EmptyNote
          title={narrowed ? t('cap.emptyFilter', { query: query.trim() }) : t('cap.skills.none')}
          body={narrowed ? undefined : t('cap.skills.noneBody')}
        />
      ) : (
        <div className="space-y-4">
          {groups.map((group) => {
            const isOpen = !isFolded(group.id);
            const all = searching || expanded.has(group.id) || group.skills.length <= GROUP_PREVIEW + 2;
            const visible = all ? group.skills : group.skills.slice(0, GROUP_PREVIEW);
            const bodyId = `skills-group-body-${group.id}`;
            return (
              <section
                key={group.id}
                id={`skills-group-${group.id}`}
                data-skills-group={group.id}
                data-open={isOpen ? 'true' : 'false'}
                className="min-w-0 [contain-intrinsic-size:auto_320px] [content-visibility:auto]"
              >
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={bodyId}
                  data-skills-fold={group.id}
                  onClick={() => { toggleFold(group.id); }}
                  className="flex min-h-9 w-full items-center gap-2 border-b border-hairline pb-1.5 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  <span aria-hidden className={`flex text-ink-faint transition-transform duration-[var(--kiki-motion-quick)] motion-reduce:transition-none ${isOpen ? 'rotate-90' : ''}`}>
                    <Icon name="chevron" size={12} />
                  </span>
                  <span className="text-[13px] font-medium text-ink">{t(GROUP_TITLE_KEYS[group.id])}</span>
                  <span className="text-[12px] text-ink-faint tabular-nums">{group.skills.length}</span>
                  {!isOpen ? (
                    <span className="ms-2 min-w-0 flex-1 truncate text-[12px] text-ink-faint">
                      {group.skills.slice(0, 5).map((skill) => skill.name).join(', ')}
                    </span>
                  ) : null}
                </button>
                {isOpen ? (
                  <div id={bodyId}>
                    <ul className="grid grid-cols-1 gap-x-6 pt-1 min-[900px]:grid-cols-2">
                      {visible.map((skill) => (
                        <SkillRow
                          key={`${skill.source}:${skill.path}`}
                          skill={skill}
                          canPreview={preview !== null}
                          onOpen={() => { open(skill); }}
                          onOpenPlugin={group.id === 'plugin' ? onOpenPlugin : undefined}
                        />
                      ))}
                    </ul>
                    {!all ? (
                      <button
                        type="button"
                        className={`${QUIET_BUTTON} mt-1 -ml-1`}
                        data-skills-show-all={group.id}
                        onClick={() => { setExpanded((current) => new Set(current).add(group.id)); }}
                      >
                        {t('cap.skills.showAll', { count: group.skills.length })}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function pluginIdFromPath(path: string): string | undefined {
  const match = /[\\/]plugins[\\/](?:managed[\\/])?([^\\/]+)[\\/]/.exec(path);
  return match?.[1];
}

/** One dense line: name · slash tag · description, then a plugin link when it has one. */
function SkillRow({
  skill,
  canPreview,
  onOpen,
  onOpenPlugin,
}: {
  readonly skill: SkillDescriptor;
  readonly canPreview: boolean;
  readonly onOpen: () => void;
  readonly onOpenPlugin?: (pluginId: string) => void;
}) {
  const { t } = useI18n();
  const pluginId = onOpenPlugin === undefined ? undefined : pluginIdFromPath(skill.path);
  const body = (
    <>
      <span className="shrink-0 truncate text-[13px] font-medium text-ink max-w-[45%]">{skill.name}</span>
      {skill.prompt_command === true ? (
        <Tag tone="accent">/{skill.name}{skill.argument_hint !== undefined ? ` ${skill.argument_hint}` : ''}</Tag>
      ) : skill.disable_model_invocation === true ? (
        <Tag>{t('cap.skills.manualOnly')}</Tag>
      ) : null}
      <span className="min-w-0 flex-1 truncate text-[12px] text-ink-faint" title={skill.description}>
        {skill.description === '' ? skill.path : skill.description}
      </span>
    </>
  );
  return (
    <li
      className="group flex min-h-9 min-w-0 items-center gap-2 rounded-md px-2 transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.04] focus-within:bg-ink/[0.04] pointer-coarse:min-h-11"
      data-skill-row={skill.name}
      data-skill-source={skill.source}
    >
      {canPreview ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={t('cap.skills.open', { name: skill.name })}
          className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded text-left focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        >
          {body}
        </button>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-2">{body}</span>
      )}
      {pluginId !== undefined && onOpenPlugin !== undefined ? (
        <button
          type="button"
          aria-label={t('cap.skills.openPlugin', { name: pluginId })}
          className="shrink-0 rounded px-1.5 text-[11px] text-ink-faint opacity-0 transition hover:bg-ink/[0.05] hover:text-ink focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-accent group-hover:opacity-100 pointer-coarse:opacity-100"
          onClick={() => { onOpenPlugin(pluginId); }}
          data-skill-plugin={pluginId}
        >
          {pluginId}
        </button>
      ) : null}
    </li>
  );
}
