// @vitest-environment jsdom

/**
 * SSH approval cards: each kind renders its own fields, answers go to the
 * SSH-only route (`klient.rest.ssh.submitApproval`) with exactly the
 * contract's body, and secrets never reach the generic resolver.
 */

import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApprovalRequest } from '@kiki/protocol';
import type { ApprovalBlock } from '@kiki/session-core/session';

import { I18nProvider } from '../../i18n';
import { ApprovalCard } from '../Interactions';
import { canWriteBack, sshHostInput, sshTargetLabel } from '../../lib/ssh';
import { sshHostFromAction } from './SshApprovalBody';

const submitApproval = vi.fn(async () => ({ resolved: true as const }));
// ApprovalCard reads the optional connection (for "always allow"); the SSH body reads the required one.
const runSessionMutation = vi.fn(async (_sessionId: string, operation: () => Promise<unknown>) => operation());
const connection = { client: { runSessionMutation, klient: { rest: { ssh: { submitApproval } } } } };
vi.mock('../../state/connection', () => ({
  useConnection: () => connection,
  useOptionalConnection: () => connection,
}));

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];
const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  env.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => { submitApproval.mockClear(); runSessionMutation.mockClear(); });
afterEach(() => {
  act(() => { for (const root of roots.splice(0)) root.unmount(); });
  for (const container of containers.splice(0)) container.remove();
});
afterAll(() => {
  env.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

function block(action: string, ssh: ApprovalRequest['ssh']): ApprovalBlock {
  return {
    kind: 'approval',
    id: 'approval-a1',
    resolution: undefined,
    request: {
      approval_id: 'a1',
      session_id: 's1',
      tool_call_id: 'c1',
      tool_name: 'Bash',
      action,
      tool_input_display: { kind: 'generic', summary: action },
      ssh,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    },
  };
}

async function render(node: React.ReactNode): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => { root.render(<MemoryRouter initialEntries={['/s/s-route']}><I18nProvider>{node}</I18nProvider></MemoryRouter>); });
  return container;
}

async function type(input: Element | null, value: string) {
  const element = input as HTMLInputElement | HTMLTextAreaElement;
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(element: Element | null) {
  await act(async () => { (element as HTMLElement).click(); });
}

const TARGET = { hostname: 'gpu.lab.example.com', user: 'ubuntu', port: 2222 };
const resolveGeneric = vi.fn(async () => {});

describe('SSH approval card', () => {
  it('connects with the user SSH setup without sending a credential', async () => {
    const view = await render(<ApprovalCard block={block('Connect SSH host GPU box (gpu-box)', { kind: 'login', ...TARGET, proxyJump: 'bastion' })} onResolve={resolveGeneric} />);
    expect(view.querySelector('[data-approval-id]')).toBeNull();
    expect(view.textContent).toContain('GPU box');
    expect(view.textContent).toContain('gpu.lab.example.com:2222');
    expect(view.textContent).toContain('bastion');
    await click(view.querySelector('[data-ssh-submit]'));
    expect(submitApproval).toHaveBeenCalledWith('s1', 'a1', { decision: 'approved' });
    expect(runSessionMutation).toHaveBeenCalledWith('s1', expect.any(Function));
    expect(resolveGeneric).not.toHaveBeenCalled();
  });

  it('sends a password with the chosen save scope and clears the field', async () => {
    const view = await render(<ApprovalCard block={block('Connect SSH host GPU box (gpu-box)', { kind: 'login', ...TARGET })} onResolve={resolveGeneric} />);
    await click(view.querySelector('[data-ssh-method="password"]'));
    expect(view.querySelector<HTMLButtonElement>('[data-ssh-submit]')!.disabled).toBe(true);
    await type(view.querySelector('[data-ssh-password]'), 's3cret');
    await click(view.querySelector('[data-ssh-save="global"]'));
    await click(view.querySelector('[data-ssh-submit]'));
    expect(submitApproval).toHaveBeenCalledWith('s1', 'a1', { decision: 'approved', credential: { password: 's3cret', save: 'global' } });
    expect(view.textContent).not.toContain('s3cret');
  });

  it('sends a pasted key with its passphrase, workspace scope by default', async () => {
    const view = await render(<ApprovalCard block={block('Connect SSH host GPU box (gpu-box)', { kind: 'login', ...TARGET })} onResolve={resolveGeneric} />);
    await click(view.querySelector('[data-ssh-method="keyText"]'));
    await type(view.querySelector('[data-ssh-key-text]'), 'KEY');
    await type(view.querySelector('[data-ssh-passphrase]'), 'pp');
    await click(view.querySelector('[data-ssh-submit]'));
    expect(submitApproval).toHaveBeenCalledWith('s1', 'a1', {
      decision: 'approved',
      credential: { privateKeyContents: 'KEY', passphrase: 'pp', save: 'workspace' },
    });
  });

  it('answers a keyboard-interactive round with one answer per prompt, masking non-echo prompts', async () => {
    const view = await render(<ApprovalCard block={block('SSH authentication for staging', {
      kind: 'login', ...TARGET, prompts: [{ prompt: 'Password: ', echo: false }, { prompt: 'Code: ', echo: true }],
    })} onResolve={resolveGeneric} />);
    const inputs = view.querySelectorAll<HTMLInputElement>('[data-ssh-prompt]');
    expect([...inputs].map((input) => input.type)).toEqual(['password', 'text']);
    await type(inputs[0]!, 'pw');
    await type(inputs[1]!, '123456');
    await click(view.querySelector('[data-ssh-submit]'));
    expect(submitApproval).toHaveBeenCalledWith('s1', 'a1', { decision: 'approved', credential: { answers: ['pw', '123456'] } });
  });

  it('keeps one answer per prompt under StrictMode remounts', async () => {
    const view = await render(<StrictMode><ApprovalCard block={block('SSH authentication for staging', {
      kind: 'login', ...TARGET, prompts: [{ prompt: 'Verification code: ', echo: true }],
    })} onResolve={resolveGeneric} /></StrictMode>);
    expect(view.querySelector<HTMLButtonElement>('[data-ssh-submit]')!.disabled).toBe(true);
    await type(view.querySelector('[data-ssh-prompt="0"]'), '482913');
    await click(view.querySelector('[data-ssh-submit]'));
    expect(submitApproval).toHaveBeenCalledWith('s1', 'a1', { decision: 'approved', credential: { answers: ['482913'] } });
  });

  it('falls back to the open session route when the live request has no session id', async () => {
    const live = block('SSH authentication for staging', { kind: 'login', ...TARGET, prompts: [{ prompt: 'Code: ', echo: true }] });
    const view = await render(<ApprovalCard block={{ ...live, request: { ...live.request, session_id: '' } }} onResolve={resolveGeneric} />);
    await type(view.querySelector('[data-ssh-prompt="0"]'), '1');
    await click(view.querySelector('[data-ssh-submit]'));
    expect(submitApproval).toHaveBeenCalledWith('s-route', 'a1', { decision: 'approved', credential: { answers: ['1'] } });
  });

  it('shows the host-key fingerprint with no credential fields and trusts with a bare decision', async () => {
    const view = await render(<ApprovalCard block={block('Trust SSH host key pi-lab', {
      kind: 'host_key', ...TARGET, algorithm: 'ssh-ed25519', fingerprint: 'SHA256:abc',
    })} onResolve={resolveGeneric} />);
    expect(view.querySelectorAll('input, textarea')).toHaveLength(0);
    expect(view.querySelector('[data-ssh-fingerprint]')!.textContent).toContain('SHA256:abc');
    await click(view.querySelector('[data-ssh-submit]'));
    expect(submitApproval).toHaveBeenCalledWith('s1', 'a1', { decision: 'approved' });
  });

  it('rejects through the SSH route', async () => {
    const view = await render(<ApprovalCard block={block('Trust SSH host key pi-lab', { kind: 'host_key', ...TARGET, algorithm: 'ssh-rsa', fingerprint: 'SHA256:x' })} onResolve={resolveGeneric} />);
    await click(view.querySelector('[data-ssh-reject]'));
    expect(submitApproval).toHaveBeenCalledWith('s1', 'a1', { decision: 'rejected' });
  });
});

describe('ssh helpers', () => {
  it('reads host names from gate actions', () => {
    expect(sshHostFromAction('Connect SSH host GPU box (gpu-box)')).toEqual({ name: 'GPU box', id: 'gpu-box' });
    expect(sshHostFromAction('SSH authentication for ubuntu@10.0.0.9')).toEqual({ name: 'ubuntu@10.0.0.9', id: 'ubuntu@10.0.0.9' });
    expect(sshHostFromAction('Running: ls')).toBeUndefined();
  });

  it('formats targets and write-back eligibility', () => {
    expect(sshTargetLabel({ hostname: 'h', user: 'u', port: 22 })).toBe('u@h');
    expect(sshTargetLabel({ hostname: 'h', port: 2222 })).toBe('h:2222');
    expect(sshTargetLabel({})).toBeUndefined();
    expect(canWriteBack({ id: 'a', name: 'a', source: 'kiki', hostname: 'h', user: 'u' })).toBe(true);
    expect(canWriteBack({ id: 'a', name: 'a', source: 'kiki', hostname: 'h' })).toBe(false);
    expect(canWriteBack({ id: 'a', name: 'a', source: 'ssh-config', hostname: 'h', user: 'u' })).toBe(false);
  });

  it('builds a PUT body that leaves blank fields to ssh config', () => {
    expect(sshHostInput({ name: ' Dev ', hostname: '', user: 'u', port: '', identityFile: '', roots: '/a\n\n /b ', description: '', offered: false }))
      .toEqual({ name: 'Dev', user: 'u', roots: ['/a', '/b'], agentAccess: 'hidden' });
  });
});
