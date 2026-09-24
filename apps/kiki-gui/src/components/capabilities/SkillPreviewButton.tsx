import { useI18n } from '../../i18n';
import { useMediaPreview } from '../mediaPreviewContext';

export function SkillPreviewButton({ skill, onOpen }: {
  readonly skill: { readonly name: string; readonly source?: string; readonly path: string };
  readonly onOpen?: () => void;
}) {
  const { t } = useI18n();
  const preview = useMediaPreview();

  return (
    <button
      type="button"
      disabled={preview === null}
      onClick={() => {
        if (skill.source === 'builtin') preview?.openBuiltinSkill(skill.name);
        else preview?.openFile(skill.path);
        onOpen?.();
      }}
      className="mt-2 border-t border-hairline pt-2 text-[11px] font-medium text-accent hover:underline cursor-pointer disabled:cursor-default disabled:text-ink-faint"
    >
      {t('agentPanel.viewSkillMd')}
    </button>
  );
}
