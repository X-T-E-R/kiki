/**
 * Declared plugin permissions in the user's terms. Declarations, not an OS
 * sandbox: the list says what the plugin asked for, and every tool call still
 * goes through the normal per-call approval. `PermissionBoundary` says that
 * in one sentence wherever the list is shown for consent or review.
 */

import { useI18n } from '../../i18n';
import type { PluginPermissionsView } from '../../lib/pluginCatalog';

export function permissionLines(
  t: ReturnType<typeof useI18n>['t'],
  permissions: PluginPermissionsView,
): readonly { readonly key: string; readonly text: string; readonly detail?: string }[] {
  const lines: { key: string; text: string; detail?: string }[] = [];
  if (permissions.fs === 'workspace') lines.push({ key: 'fs', text: t('cap.perm.fsWorkspace') });
  if (permissions.fs === 'outside') lines.push({ key: 'fs', text: t('cap.perm.fsOutside') });
  if ((permissions.exec?.length ?? 0) > 0) lines.push({ key: 'exec', text: t('cap.perm.exec'), detail: permissions.exec!.join(', ') });
  if ((permissions.net?.length ?? 0) > 0) lines.push({ key: 'net', text: t('cap.perm.net'), detail: permissions.net!.join(', ') });
  if (permissions.secrets === true) lines.push({ key: 'secrets', text: t('cap.perm.secrets') });
  if (permissions.uiPanel === true) lines.push({ key: 'uiPanel', text: t('cap.perm.uiPanel') });
  return lines;
}

export function PermissionList({ permissions, className = '' }: { readonly permissions: PluginPermissionsView; readonly className?: string }) {
  const { t } = useI18n();
  const lines = permissionLines(t, permissions);
  if (lines.length === 0) return <p className={`text-[13px] text-ink-soft ${className}`}>{t('cap.install.noPermissions')}</p>;
  return (
    <ul className={`space-y-1 ${className}`} data-permission-list>
      {lines.map((line) => (
        <li key={line.key} data-permission={line.key} className="text-[13px] text-ink">
          {line.text}
          {line.detail !== undefined ? <span className="font-mono text-[12px] text-ink-faint"> · {line.detail}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * The trust boundary, stated where the permissions are: consent to install is
 * not per-call approval and not a sandbox. Same sentence in the install sheet
 * and on the detail page so the two never disagree.
 */
export function PermissionBoundary({ className = '' }: { readonly className?: string }) {
  const { t } = useI18n();
  return (
    <p className={`max-w-[62ch] border-l-2 border-hairline-strong pl-3 text-[12px] leading-[18px] text-ink-soft ${className}`} data-permission-boundary>
      {t('cap.perm.boundary')}
    </p>
  );
}
