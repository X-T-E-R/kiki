import { client, methods } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';

import { sessionConfigOptionsFromResponse } from '../src/client';
import { createInProcessScriptedAgent } from './fixtures/in-process-scripted-agent';

describe('in-process scripted ACP agent fixture', () => {
  it('drives initialize/new/config/prompt/update/permission/cancel through SDK direct connect', async () => {
    const { app: agentApp, history } = createInProcessScriptedAgent({
      promptUpdates: [
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'hello' },
        },
      ],
      permissionOptions: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      ],
      hangPrompt: true,
    });
    const updates: unknown[] = [];
    const clientApp = client({ name: 'fixture-client' })
      .onNotification(methods.client.session.update, ({ params }) => {
        updates.push(params.update);
      })
      .onRequest(methods.client.session.requestPermission, ({ params }) => ({
        outcome: { outcome: 'selected', optionId: params.options[0]!.optionId },
      }));
    const connection = clientApp.connect(agentApp);

    await connection.agent.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    const created = await connection.agent.request(methods.agent.session.new, {
      cwd: process.cwd(),
      mcpServers: [],
    });
    await connection.agent.request(methods.agent.session.setConfigOption, {
      sessionId: created.sessionId,
      configId: 'model',
      value: 'model-b',
    });
    const prompt = connection.agent.request(methods.agent.session.prompt, {
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'go' }],
    });
    while (history.permissionResponses.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await connection.agent.notify(methods.agent.session.cancel, {
      sessionId: created.sessionId,
    });

    await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' });
    expect(updates).toHaveLength(1);
    expect(history.methods).toEqual([
      'initialize',
      'session/new',
      'session/set_config_option',
      'session/prompt',
    ]);
    expect(history.configValues).toEqual([{ configId: 'model', value: 'model-b' }]);
    expect(history.permissionResponses).toEqual([
      { outcome: { outcome: 'selected', optionId: 'allow-once' } },
    ]);
    expect(history.cancelCount).toBe(1);
    connection.close();
    await connection.closed;
  });

  it('synthesizes Grok private session config as standard model and thought options', () => {
    expect(sessionConfigOptionsFromResponse({
      _meta: {
        'x.ai/sessionConfig': {
          options: [
            { id: 'grok-4.6', category: 'model', label: 'Grok 4.6', selected: true },
            { id: 'grok-4.5', category: 'model', label: 'Grok 4.5', selected: false },
            { id: 'high', category: 'mode', label: 'High', selected: true },
          ],
        },
      },
    })).toEqual([
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'grok-4.6',
        options: [
          { value: 'grok-4.6', name: 'Grok 4.6', description: undefined },
          { value: 'grok-4.5', name: 'Grok 4.5', description: undefined },
        ],
        _meta: { 'kiki.transport': 'session/set_model' },
      },
      {
        id: 'reasoning_effort',
        name: 'Reasoning effort',
        category: 'thought_level',
        type: 'select',
        currentValue: 'high',
        options: [{ value: 'high', name: 'High', description: undefined }],
        _meta: { 'kiki.transport': 'session/set_model' },
      },
    ]);
  });

  it('keeps unknown vendor session config categories visible', () => {
    expect(sessionConfigOptionsFromResponse({
      _meta: {
        'x.ai/sessionConfig': {
          options: [
            { id: 'grok-4.6', category: 'model', label: 'Grok 4.6', selected: true },
            { id: 'verbose', category: 'verbosity', label: 'Verbose', selected: true },
            { id: 'quiet', category: 'verbosity', label: 'Quiet', selected: false },
          ],
        },
      },
    })).toContainEqual({
      id: 'verbosity',
      name: 'verbosity',
      category: 'verbosity',
      type: 'select',
      currentValue: 'verbose',
      options: [
        { value: 'verbose', name: 'Verbose', description: undefined },
        { value: 'quiet', name: 'Quiet', description: undefined },
      ],
    });
  });

  it('scripts resume/load method-not-found and unknown-session failures', async () => {
    const { app: agentApp } = createInProcessScriptedAgent({
      resume: 'method_not_found',
      load: 'unknown_session',
    });
    const connection = client().connect(agentApp);
    await connection.agent.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    await expect(connection.agent.request(methods.agent.session.resume, {
      sessionId: 'missing',
      cwd: process.cwd(),
    })).rejects.toMatchObject({ code: -32601 });
    await expect(connection.agent.request(methods.agent.session.load, {
      sessionId: 'missing',
      cwd: process.cwd(),
      mcpServers: [],
    })).rejects.toMatchObject({ code: -32002 });
    connection.close();
  });
});
