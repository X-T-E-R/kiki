// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import { ModelGenerationMigrationCard } from './ModelsSection';

const previewModelGenerationMigration = vi.fn();
const applyModelGenerationMigration = vi.fn();
const restoreModelGenerationMigration = vi.fn();

vi.mock('../../state/connection', () => ({
  useConnection: () => ({ client: { previewModelGenerationMigration, applyModelGenerationMigration, restoreModelGenerationMigration } }),
}));

const revision = 'a'.repeat(64);
const backup = 'config.toml.generation-backup-123e4567-e89b-42d3-a456-426614174000';
const roots: Root[] = [];
const containers: HTMLDivElement[] = [];

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

beforeEach(() => {
  previewModelGenerationMigration.mockReset().mockResolvedValue({
    revision,
    changes: [{ model_id: 'model', fields: ['temperature'] }],
    needs_review: [{ model_id: 'model', code: 'max_output_size' }],
    backups: [],
  });
  applyModelGenerationMigration.mockReset().mockResolvedValue({ revision: 'b'.repeat(64), backup_key: backup });
  restoreModelGenerationMigration.mockReset().mockResolvedValue({ revision });
});

afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  for (const container of containers.splice(0)) container.remove();
});
afterAll(() => { vi.unstubAllGlobals(); });

async function render(): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<MemoryRouter><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <I18nProvider><ModelGenerationMigrationCard /></I18nProvider>
    </QueryClientProvider></MemoryRouter>);
  });
  return container;
}

async function click(container: HTMLElement, label: string): Promise<void> {
  const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(label));
  expect(button, `Missing button ${label}`).toBeDefined();
  await act(async () => { button!.click(); });
}

describe('explicit model migration settings card', () => {
  it('does not write on open or preview, applies only after explicit confirmation, restores only after separate confirmation', async () => {
    previewModelGenerationMigration.mockResolvedValueOnce({
      revision, changes: [{ model_id: 'model', fields: ['temperature'] }],
      needs_review: [{ model_id: 'model', code: 'max_output_size' }], backups: [],
    }).mockResolvedValueOnce({
      revision: 'b'.repeat(64), changes: [], needs_review: [],
      backups: [backup],
    });
    const container = await render();
    expect(previewModelGenerationMigration).not.toHaveBeenCalled();
    expect(applyModelGenerationMigration).not.toHaveBeenCalled();
    await click(container, 'Preview migration');
    expect(previewModelGenerationMigration).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('temperature');
    expect(container.textContent).toContain('max_output_size');
    expect(applyModelGenerationMigration).not.toHaveBeenCalled();
    await click(container, 'Apply previewed changes');
    expect(container.textContent).toContain('byte-exact config backup');
    expect(applyModelGenerationMigration).not.toHaveBeenCalled();
    await click(container, 'Back up and apply');
    expect(applyModelGenerationMigration).toHaveBeenCalledWith(revision);
    expect(container.textContent).not.toContain(backup);
    expect(container.textContent).toContain('config backup was written');
    expect(container.textContent).toContain('preview migration again');
    expect(container.textContent).not.toContain('Keep the backup identifier');
    expect(restoreModelGenerationMigration).not.toHaveBeenCalled();
    await click(container, 'Preview migration');
    expect(container.textContent).toContain(backup);
    await click(container, 'Restore backup');
    expect(container.textContent).toContain('replaces the current config');
    expect(restoreModelGenerationMigration).not.toHaveBeenCalled();
    await click(container, 'Restore exact backup');
    expect(restoreModelGenerationMigration).toHaveBeenCalledWith(backup, 'b'.repeat(64));
  });

  it('cancelling either confirmation does not send a write request', async () => {
    previewModelGenerationMigration.mockResolvedValueOnce({ revision, changes: [{ model_id: 'model', fields: ['temperature'] }], needs_review: [], backups: [backup] });
    const container = await render();
    await click(container, 'Preview migration');
    await click(container, 'Apply previewed changes');
    await click(container, 'Cancel');
    expect(applyModelGenerationMigration).not.toHaveBeenCalled();
    await click(container, 'Restore backup');
    await click(container, 'Cancel');
    expect(restoreModelGenerationMigration).not.toHaveBeenCalled();
  });

  it('shows saved backups and rechecks the current revision before restoring', async () => {
    previewModelGenerationMigration.mockResolvedValueOnce({
      revision, changes: [], needs_review: [], backups: [backup],
    });
    restoreModelGenerationMigration.mockRejectedValueOnce({ code: 40941 });
    const container = await render();
    await click(container, 'Preview migration');
    expect(container.textContent).toContain(backup);
    await click(container, 'Restore backup');
    expect(restoreModelGenerationMigration).not.toHaveBeenCalled();
    await click(container, 'Restore exact backup');
    expect(restoreModelGenerationMigration).toHaveBeenCalledWith(backup, revision);
    expect(container.textContent).toContain('Config changed');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Config changed');
    expect(container.textContent).not.toContain(backup);
  });

  it('marks the clicked backup as restoring and accepts no second restore request', async () => {
    previewModelGenerationMigration.mockResolvedValueOnce({
      revision, changes: [], needs_review: [], backups: [backup],
    });
    let settle: (() => void) | undefined;
    restoreModelGenerationMigration.mockImplementationOnce(() => new Promise<void>((resolve) => { settle = resolve; }));
    const container = await render();
    await click(container, 'Preview migration');
    await click(container, 'Restore backup');
    await click(container, 'Restore exact backup');
    expect(restoreModelGenerationMigration).toHaveBeenCalledTimes(1);
    const restoring = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Restoring…');
    expect(restoring?.disabled).toBe(true);
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    await act(async () => { settle?.(); });
    expect(restoreModelGenerationMigration).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Backup restored');
    expect(container.textContent).not.toContain('Restoring…');
  });

  it('invalidates a conflicting preview without sending a second write', async () => {
    applyModelGenerationMigration.mockRejectedValueOnce({ code: 40941 });
    const container = await render();
    await click(container, 'Preview migration');
    await click(container, 'Apply previewed changes');
    await click(container, 'Back up and apply');
    expect(container.textContent).toContain('Config changed');
    expect(container.textContent).not.toContain('Apply previewed changes');
    expect(applyModelGenerationMigration).toHaveBeenCalledTimes(1);
    await click(container, 'Preview migration');
    expect(previewModelGenerationMigration).toHaveBeenCalledTimes(2);
  });
});
