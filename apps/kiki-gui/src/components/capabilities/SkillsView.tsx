/**
 * Skills — built to hold a hundred. The shared settings list pattern does the
 * work: one toolbar with search, a chip per source and the density switch;
 * below, skills group by where they come from and every group folds (the fold
 * is remembered on this device). A search narrows every group at once and
 * unfolds them. Rows open their SKILL.md in the preview panel. Long groups
 * window inside ListBody, so a large catalog stays cheap to render.
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import type { SkillDescriptor } from '@kiki/protocol';

import { useI18n } from '../../i18n';
import { SKILL_GROUP_ORDER, skillGroupId } from '../../lib/capabilities';
import { useConnection } from '../../state/connection';
import { InlineError } from '../controls';
import { useMediaPreview } from '../mediaPreviewContext';
import {
  groupItems,
  LIST_ROW_HEIGHT,
  ListBody,
  ListEmpty,
  ListGroup,
  ListToolbar,
  useListView,
  type ListDensity,
  type ListFilterSpec,
} from '../settings/list';
import { EmptyNote, Tag } from './primitives';

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

export function SkillsView({
  workspaceId,
  onOpenPlugin,
}: {
  readonly workspaceId: string;
  /** Plugin-sourced skills link to their plugin when the host can show it. */
  readonly onOpenPlugin?: (pluginId: string) => void;
}) {
  const { client } = useConnection();
  const { t } = useI18n();
  const preview = useMediaPreview();
  const skillsQuery = useQuery({
    queryKey: ['workspace-skills', workspaceId],
    queryFn: () => client.listWorkspaceSkills(workspaceId),
    enabled: workspaceId !== '',
    staleTime: 60_000,
  });
  const allSkills = useMemo(() => skillsQuery.data?.skills ?? [], [skillsQuery.data]);

  const keyOf = (skill: SkillDescriptor) => `${skill.source}:${skill.path}`;
  const textOf = (skill: SkillDescriptor) => [skill.name, skill.description];
  const filters = useMemo<readonly ListFilterSpec<SkillDescriptor>[]>(() => {
    const present = new Set(allSkills.map((skill) => skillGroupId(skill.source)));
    return SKILL_GROUP_ORDER.filter((id) => present.has(id)).map((id) => ({
      id, label: t(SOURCE_LABEL_KEYS[id]), test: (skill: SkillDescriptor) => skillGroupId(skill.source) === id,
    }));
  }, [allSkills, t]);
  const view = useListView({ listId: 'cap-skills', items: allSkills, keyOf, textOf, filters });
  const groups = useMemo(
    () => groupItems(allSkills, view.visible, (skill) => {
      const id = skillGroupId(skill.source);
      return [{ key: id, label: t(GROUP_TITLE_KEYS[id]) }];
    }, SKILL_GROUP_ORDER),
    [allSkills, view.visible, t],
  );

  const open = (skill: SkillDescriptor) => {
    if (skill.source === 'builtin') preview?.openBuiltinSkill(skill.name);
    else preview?.openFile(skill.path);
  };

  // The capabilities page scrolls its own container, not the settings pane;
  // re-anchor the sticky toolbar to its padding.
  return (
    <div className="min-w-0 space-y-3 [&_[data-list-toolbar]]:-top-4 min-[720px]:[&_[data-list-toolbar]]:-top-8" data-skills-view>
      {allSkills.length > 0 ? (
        <ListToolbar view={view} total={allSkills.length} filters={filters}
          searchLabel={t('cap.skills.search')} searchPlaceholder={t('cap.skills.searchCount', { count: allSkills.length })} />
      ) : null}

      {workspaceId === '' ? (
        <EmptyNote title={t('cap.noWorkspace')} body={t('cap.noWorkspaceBody')}
          action={<Link to="/new" className="inline-flex min-h-8 items-center rounded-md bg-ink/[0.06] px-3 text-[13px] text-ink hover:bg-ink/[0.1] focus-visible:outline-2 focus-visible:outline-selected-ink">{t('cap.openWorkspace')}</Link>} />
      ) : skillsQuery.isPending ? (
        <p className="text-[13px] text-ink-faint" role="status">{t('cap.loadingSkills')}</p>
      ) : skillsQuery.isError ? (
        <InlineError error={skillsQuery.error} />
      ) : allSkills.length === 0 ? (
        <ListEmpty kind="none" title={t('cap.skills.none')} body={t('cap.skills.noneBody')} />
      ) : view.visible.length === 0 ? (
        <ListEmpty kind="no-match" title={t('cap.skills.noMatchTitle')}
          body={view.query.trim() !== '' ? t('cap.emptyFilter', { query: view.query.trim() }) : undefined}
          onClear={view.clear} />
      ) : (
        groups.map((group) => (
          <ListGroup key={group.key} groupKey={group.key} label={group.label} count={group.items.length} total={group.total}
            folded={view.isFolded(group.key)} onToggle={() => { view.toggleFold(group.key); }}>
            <ListBody items={group.items} keyOf={keyOf} density={view.density} label={group.label}
              renderRow={(skill) => (
                <SkillRow
                  skill={skill}
                  density={view.density}
                  canPreview={preview !== null}
                  onOpen={() => { open(skill); }}
                  onOpenPlugin={group.key === 'plugin' ? onOpenPlugin : undefined}
                />
              )} />
          </ListGroup>
        ))
      )}
    </div>
  );
}

function pluginIdFromPath(path: string): string | undefined {
  const match = /[\\/]plugins[\\/](?:managed[\\/])?([^\\/]+)[\\/]/.exec(path);
  return match?.[1];
}

/** One row: name · slash tag · description, then a plugin link when it has one. */
function SkillRow({
  skill,
  density,
  canPreview,
  onOpen,
  onOpenPlugin,
}: {
  readonly skill: SkillDescriptor;
  readonly density: ListDensity;
  readonly canPreview: boolean;
  readonly onOpen: () => void;
  readonly onOpenPlugin?: (pluginId: string) => void;
}) {
  const { t } = useI18n();
  const pluginId = onOpenPlugin === undefined ? undefined : pluginIdFromPath(skill.path);
  const compact = density === 'compact';
  const tag = skill.prompt_command === true ? (
    <Tag tone="accent">/{skill.name}{skill.argument_hint !== undefined ? ` ${skill.argument_hint}` : ''}</Tag>
  ) : skill.disable_model_invocation === true ? (
    <Tag>{t('cap.skills.manualOnly')}</Tag>
  ) : null;
  const description = skill.description === '' ? skill.path : skill.description;
  const body = compact ? (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <span className="shrink-0 truncate text-[13px] font-medium text-ink max-w-[45%]">{skill.name}</span>
      {tag}
      <span className="min-w-0 flex-1 truncate text-[12px] text-ink-faint" title={description}>{description}</span>
    </span>
  ) : (
    <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
      <span className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 truncate text-[13px] font-medium text-ink max-w-[45%]">{skill.name}</span>
        {tag}
      </span>
      <span className="min-w-0 truncate text-[12px] text-ink-faint" title={description}>{description}</span>
    </span>
  );
  return (
    <div
      className="group flex min-w-0 items-center gap-2 px-3 transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.04] focus-within:bg-ink/[0.04]"
      style={{ minHeight: LIST_ROW_HEIGHT[density] }}
      data-skill-row={skill.name}
      data-skill-source={skill.source}
    >
      {canPreview ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={t('cap.skills.open', { name: skill.name })}
          className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded text-left focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink"
        >
          {body}
        </button>
      ) : (
        body
      )}
      {pluginId !== undefined && onOpenPlugin !== undefined ? (
        <button
          type="button"
          aria-label={t('cap.skills.openPlugin', { name: pluginId })}
          className="shrink-0 rounded px-1.5 text-[11px] text-ink-faint opacity-0 transition hover:bg-ink/[0.05] hover:text-ink focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-selected-ink group-hover:opacity-100 pointer-coarse:opacity-100"
          onClick={() => { onOpenPlugin(pluginId); }}
          data-skill-plugin={pluginId}
        >
          {pluginId}
        </button>
      ) : null}
    </div>
  );
}
