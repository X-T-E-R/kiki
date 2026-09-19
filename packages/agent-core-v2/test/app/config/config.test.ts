import type { ModelCapability } from '#/kosong/contract/capability';
import type { ToolCall } from '#/kosong/contract/message';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IAgentProfileService, type ResolvedAgentProfile } from '#/agent/profile/profile';
import { normalizeAgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import {
  Error2,
  ErrorCodes,
  isError2,
  resetUnexpectedErrorHandler,
  setUnexpectedErrorHandler,
  toErrorPayload,
} from '#/errors';
import { WIRE_PROTOCOL_VERSION } from '#/wire/migration/migration';
import { createTestAgent, type TestAgentContext } from '../../harness';
import { DEFAULT_TEST_SYSTEM_PROMPT } from '../../harness/snapshots';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { createDecorator, type ProvideHandle } from '#/_base/di/instantiation';
import { DisposableStore } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { TestInstantiationService } from '#/_base/di/test';
import { Event } from '#/_base/event';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import {
  type ConfigSchema,
  ConfigTarget,
  IConfigRegistry,
  IConfigService,
  type RegisterSectionOptions,
} from '#/app/config/config';
import { ConfigRegistry, ConfigService } from '#/app/config/configService';
import { ConfigSectionContribution } from '#/app/config/configSectionContributions';
import { ConfigWriteValidatorContribution } from '#/app/config/configWriteValidation';
import { CRON_SECTION, DEFAULT_CRON_CONFIG, type CronConfig } from '#/app/cron/configSection';
import {
  THREAD_COMMUNICATION_SECTION,
  type ThreadCommunicationConfig,
} from '#/app/threadCommunication/configSection';
import '#/app/skillCatalog/configSection';
import { BUILTIN_PRODUCT_SKILLS_SECTION } from '#/app/skillCatalog/configSection';
import {
  EXTRA_SKILL_DIRS_SECTION,
  MERGE_ALL_AVAILABLE_SKILLS_SECTION,
} from '#/app/skillCatalog/configSection';
import '#/agent/permissionMode/configSection';
import { DEFAULT_PERMISSION_MODE_SECTION } from '#/agent/permissionMode/configSection';
import '#/agent/media/configSection';
import { IMAGE_SECTION, type ImageConfig } from '#/agent/media/configSection';
import '#/agent/tokenCounting/configSection';
import {
  TOKEN_COUNTING_SECTION,
  TOKEN_COUNTING_STRATEGY_ENV,
  type TokenCountingConfig,
} from '#/agent/tokenCounting/configSection';
import '#/agent/loop/configSection';
import {
  DEFAULT_COMPACTION_SOFT_CONTEXT_SIZE,
  LOOP_COMPACTION_SOFT_CONTEXT_SIZE_ENV,
  LOOP_CONTROL_SECTION,
  LOOP_MAX_ATTEMPTS_PER_STEP_ENV,
  LOOP_MAX_RETRIES_PER_STEP_ENV,
  LOOP_MAX_STEPS_PER_TURN_ENV,
  type LoopControl,
} from '#/agent/loop/configSection';
import { RETRY_SECTION, type RetryConfig } from '#/agent/stepRetry/configSection';
import {
  DEFAULT_MODEL_SECTION,
  MODELS_SECTION,
  PROVIDERS_SECTION,
  THINKING_SECTION,
} from '#/app/kosongConfig/configSection';
import '#/app/kosongConfig/envOverlay';
import type { IModelService } from '#/kosong/model/model';
import { type ThinkingConfig } from '#/kosong/model/thinking';
import {
  KEEP_ALIVE_ON_EXIT_ENV,
  MAX_RUNNING_TASKS_ENV,
  resolveAgentTaskConfig,
  resolvePrintBackgroundMode,
  type AgentTaskConfig,
} from '#/agent/task/configSection';
import { applyPrintModeConfigDefaults } from '#/agent/task/printDefaults';
import '#/session/subagent/configSection';
import {
  canonicalizeSubagentBinding,
  DEFAULT_SUBAGENT_PROFILE,
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  formatSubagentTimeoutDescription,
  resolveSubagentBinding,
  resolveSubagentTimeoutMs,
  subagentModelSource,
  SUBAGENT_MODEL_UNBOUND_HINT,
  SUBAGENT_SECTION,
  SUBAGENT_TIMEOUT_ENV,
  type SubagentConfig,
} from '#/session/subagent/configSection';
import { NB_SEARCH_SECTION, type NbSearchConfig } from '#/app/nbSearch/configSection';
import '#/app/mcpConfig/configSection';
import {
  MCP_SECTION,
  MCP_STARTUP_TIMEOUT_ENV,
  MCP_TOOL_TIMEOUT_ENV,
  McpSectionSchema,
  type McpSection,
} from '#/app/mcpConfig/configSection';
import { ILogService } from '#/_base/log/log';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { TomlAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { stubBootstrap } from '../bootstrap/stubs';
import { stubLog } from '../../_base/log/stubs';
import { stubFlag } from '../flag/stubs';

const TEST_OS_ENV = {
  osKind: 'Linux',
  osArch: 'x86_64',
  osVersion: 'test',
  shellName: 'bash',
  shellPath: '/bin/bash',
} as const;

describe('Agent config', () => {
  let ctx: TestAgentContext;
  let profile: IAgentProfileService;

  beforeEach(() => {
    ctx = createTestAgent();
    profile = ctx.get(IAgentProfileService);
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('exposes system prompt, thinking level, and model capability updates', async () => {
    const initialCapability: ModelCapability = {
      image_in: true,
      video_in: false,
      audio_in: false,
      thinking: false,
      tool_use: true,
      max_context_tokens: 128000,
    };
    ctx.configureRuntimeModel(
      {
        type: 'openai',
        apiKey: 'sk-initial',
        baseUrl: 'https://initial.example/v1',
        model: 'gpt-initial',
      },
      initialCapability,
    );

    await expect(ctx.rpc.getConfig({})).resolves.toMatchObject({
      systemPrompt: DEFAULT_TEST_SYSTEM_PROMPT,
      thinkingLevel: 'off',
      modelCapabilities: initialCapability,
    });

    const nextCapability: ModelCapability = {
      image_in: true,
      video_in: true,
      audio_in: false,
      thinking: true,
      tool_use: true,
      max_context_tokens: 262144,
    };
    ctx.configureRuntimeModel(
      {
        type: 'kimi',
        apiKey: 'sk-next',
        baseUrl: 'https://next.example/v1',
        model: 'kimi-next',
      },
      nextCapability,
    );
    profile.update({
      systemPrompt: 'Changed profile prompt.',
      thinkingLevel: 'high',
    });

    await expect(ctx.rpc.getConfig({})).resolves.toMatchObject({
      systemPrompt: 'Changed profile prompt.',
      thinkingLevel: 'on',
      modelCapabilities: nextCapability,
    });
  });

  it('useProfile emits the rendered system prompt and active tools', async () => {
    const resolvedProfile: ResolvedAgentProfile = normalizeAgentProfile({
      name: 'test-profile',
      systemPrompt: () => 'Profile system prompt.',
      tools: ['Read'],
    });

    profile.useProfile(resolvedProfile, {
      osEnv: TEST_OS_ENV,
      cwd: process.cwd(),
    });

    expect(ctx.newEvents()).toMatchInlineSnapshot(`
      [wire] config.update            { "profileName": "test-profile", "systemPrompt": "Profile system prompt.", "environmentDisclosure": { "cwd": "<cwd>", "date": { "disclosed": false } }, "agentsMdPaths": [], "disallowedTools": [], "time": "<time>" }
      [emit] agent.status.updated     { "time": "<time>", "model": "mock-model", "maxContextTokens": 1000000 }
      [wire] tools.set_active_tools   { "names": [ "Read" ], "time": "<time>" }
    `);
  });

  it('useProfile passes additionalDirsInfo to profile system prompts', async () => {
    const resolvedProfile: ResolvedAgentProfile = normalizeAgentProfile({
      name: 'context-profile',
      systemPrompt: (context) =>
        `Prompt with additional dirs: ${context['additionalDirsInfo'] ?? 'none'}`,
      tools: ['Read'],
    });

    profile.useProfile(resolvedProfile, {
      osEnv: TEST_OS_ENV,
      cwd: process.cwd(),
      cwdListing: 'cwd listing',
      agentsMd: 'agents md',
      additionalDirsInfo: '### /extra\nextra-file.txt',
    });

    expect(profile.data().systemPrompt).toBe(
      'Prompt with additional dirs: ### /extra\nextra-file.txt',
    );

    profile.useProfile(resolvedProfile, {
      osEnv: TEST_OS_ENV,
      cwd: process.cwd(),
    });

    expect(profile.data().systemPrompt).toBe('Prompt with additional dirs: none');
  });

  it('restores config and active tools through activated handlers', async () => {
    await ctx.restore([
      {
        type: 'metadata',
        protocol_version: WIRE_PROTOCOL_VERSION,
        created_at: 1,
      },
      {
        type: 'profile.bind',
        cwd: '/restored-cwd',
        modelAlias: 'restored-model',
        profileName: 'restored-profile',
        thinkingEffort: 'off',
        systemPrompt: 'Restored prompt.',
        disallowedTools: [],
      },
      {
        type: 'tools.set_active_tools',
        names: ['Read'],
      },
    ]);

    expect(profile.data()).toMatchObject({
      modelAlias: 'restored-model',
      profileName: 'restored-profile',
      systemPrompt: 'Restored prompt.',
      activeToolNames: ['Read'],
    });
  });

  it('config.update initializes builtin tools', async () => {
    const tools = await ctx.rpc.getTools({});

    expect(toolNames(tools)).toEqual(
      expect.arrayContaining(['Read', 'Write', 'Edit', 'Grep', 'Glob']),
    );
  });

  it('keeps turn-start config for later steps and applies updates to the next turn', async () => {
    const lookupCall: ToolCall = {
      type: 'function',
      id: 'call_lookup',
      name: 'Lookup',
      arguments: '{"query":"original"}',
    };
    profile.update({ activeToolNames: ['Lookup'] });
    await ctx.rpc.registerTool({
      name: 'Lookup',
      description: 'Look up a short test value.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    });
    ctx.newEvents();

    ctx.mockNextResponse({ type: 'text', text: 'I will look it up.' }, lookupCall);
    await ctx.rpc.prompt({
      input: [{ type: 'text', text: 'Look up before config changes' }],
    });
    expect(await ctx.untilApproval(true)).toMatchInlineSnapshot(`
      [wire] prompt.accepted                 { "promptId": "<msg-1>", "time": "<time>" }
      [emit] prompt.submitted                { "time": "<time>", "agentId": "main", "promptId": "<msg-1>", "userMessageId": "<msg-1>", "status": "running", "content": [ { "type": "text", "text": "Look up before config changes" } ], "createdAt": "<time>", "appendTiming": "agent_idle", "revision": 0 }
      [wire] prompt.enqueued                 { "schemaVersion": 1, "promptId": "<msg-1>", "userMessageId": "<msg-1>", "createdAt": "<time>", "message": { "role": "user", "content": [ { "type": "text", "text": "Look up before config changes" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-1>" }, "alreadyMaterialized": false, "appendTiming": "agent_idle", "revision": 0, "queueIndex": 0, "time": "<time>" }
      [wire] prompt.launch_committed         { "launchId": "<uuid-1>", "promptId": "<msg-1>", "revision": 0, "committedAt": "<time>", "time": "<time>" }
      [emit] turn.prompt                     { "time": "<time>", "turnId": 0, "promptId": "<msg-1>", "input": [ { "type": "text", "text": "Look up before config changes" } ], "origin": { "kind": "user" } }
      [emit] turn.started                    { "time": "<time>", "turnId": 0, "origin": { "kind": "user" }, "prompt": "Look up before config changes", "promptId": "<msg-1>" }
      [emit] agent.activity.updated          { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 0, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [emit] context.spliced                 { "time": "<time>", "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Look up before config changes" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-1>" } ] }
      [emit] prompt.started                  { "time": "<time>", "agentId": "main", "promptId": "<msg-1>" }
      [wire] turn.prompt                     { "turnId": 0, "promptId": "<msg-1>", "input": [ { "type": "text", "text": "Look up before config changes" } ], "origin": { "kind": "user" }, "time": "<time>" }
      [wire] context.append_message          { "message": { "role": "user", "content": [ { "type": "text", "text": "Look up before config changes" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-1>" }, "time": "<time>" }
      [wire] plugin.session_start            { "content": null, "time": "<time>" }
      [emit] turn.step.started               { "time": "<time>", "turnId": 0, "step": 1, "stepId": "<uuid-2>" }
      [emit] agent.activity.updated          { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [emit] context.append_loop_event       { "time": "<time>", "event": { "type": "step.begin", "uuid": "<uuid-2>", "turnId": "0", "step": 1 } }
      [wire] context.append_loop_event       { "event": { "type": "step.begin", "uuid": "<uuid-2>", "turnId": "0", "step": 1 }, "time": "<time>" }
      [wire] llm.tools_snapshot              { "hash": "3bfeb22e61431247933e79f6ab94e7ca14a127f899bc87e7bbd22594ba9cdb66", "tools": [ { "name": "Lookup", "description": "Look up a short test value.", "parameters": { "type": "object", "properties": { "query": { "type": "string" } }, "required": [ "query" ], "additionalProperties": false } } ], "time": "<time>" }
      [wire] llm.request                     { "kind": "loop", "provider": "openai", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 1000000, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "3bfeb22e61431247933e79f6ab94e7ca14a127f899bc87e7bbd22594ba9cdb66", "messageCount": 1, "turnStep": "0.1", "time": "<time>" }
      [emit] assistant.delta                 { "time": "<time>", "turnId": 0, "step": 1, "stepId": "<uuid-2>", "partId": "<uuid-3>", "delta": "I will look it up." }
      [emit] agent.activity.updated          { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "streaming", "stream": "assistant", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [emit] tool.call.delta                 { "time": "<time>", "turnId": 0, "step": 1, "stepId": "<uuid-2>", "toolCallId": "call_lookup", "name": "Lookup", "argumentsPart": "{\\"query\\":\\"original\\"}" }
      [emit] agent.activity.updated          { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "streaming", "stream": "tool_call", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [wire] usage.record                    { "model": "mock-model", "usage": { "inputOther": 9, "output": 17, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "turnId": 0, "agentId": "main", "provider": "test-provider", "modelAlias": "mock-model", "executorId": "native", "usageKnown": true, "time": "<time>" }
      [emit] agent.status.updated            { "time": "<time>", "usage": { "byModel": { "mock-model": { "inputOther": 9, "output": 17, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 9, "output": 17, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 9, "output": 17, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] token_counting.measured         { "length": 2, "tokens": 26, "time": "<time>" }
      [emit] agent.status.updated            { "time": "<time>", "contextTokens": 26 }
      [emit] context.append_loop_event       { "time": "<time>", "event": { "type": "content.part", "uuid": "<uuid-3>", "turnId": "0", "step": 1, "stepUuid": "<uuid-2>", "part": { "type": "text", "text": "I will look it up." } } }
      [wire] context.append_loop_event       { "event": { "type": "content.part", "uuid": "<uuid-3>", "turnId": "0", "step": 1, "stepUuid": "<uuid-2>", "part": { "type": "text", "text": "I will look it up." } }, "time": "<time>" }
      [emit] permission.approval.requested   { "time": "<time>", "id": "<approval-1>", "sessionId": "test-session", "agentId": "main", "turnId": 0, "toolCallId": "call_lookup", "toolName": "Lookup", "action": "Approve Lookup", "display": { "kind": "generic", "summary": "Approve Lookup", "detail": { "query": "original" } }, "toolInput": { "query": "original" } }
      [emit] agent.activity.updated          { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "streaming", "stream": "tool_call", "step": 1, "ending": false, "pendingApprovals": [ { "approvalId": "<approval-1>", "toolCallId": "call_lookup", "since": "<time>" } ], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [emit] requestApproval                 { "id": "<approval-1>", "turnId": 0, "toolCallId": "call_lookup", "toolName": "Lookup", "action": "Approve Lookup", "display": { "kind": "generic", "summary": "Approve Lookup", "detail": { "query": "original" } } }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: Lookup
      messages:
        user: text "Look up before config changes"
    `);

    ctx.configureRuntimeModel({
      type: 'kimi',
      apiKey: 'test-key',
      baseUrl: 'https://changed.example.test/v1',
      model: 'changed-model',
    });
    profile.update({ systemPrompt: 'Changed system prompt.' });
    await ctx.rpc.setActiveTools({ names: [] });

    const toolCallEvents = ctx.untilToolCall({
      content: 'original-result',
      output: 'original-result',
    });
    ctx.mockNextResponse({ type: 'text', text: 'Still using the original turn config.' });
    await toolCallEvents;
    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] context.append_loop_event   { "event": { "type": "tool.call", "uuid": "<uuid-4>", "turnId": "0", "step": 1, "stepUuid": "<uuid-2>", "toolCallId": "call_lookup", "name": "Lookup", "args": { "query": "original" } }, "time": "<time>" }
      [emit] tool.result                 { "time": "<time>", "turnId": 0, "toolCallId": "call_lookup", "output": "original-result" }
      [emit] agent.activity.updated      { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [emit] context.append_loop_event   { "time": "<time>", "event": { "type": "tool.result", "parentUuid": "<uuid-4>", "toolCallId": "call_lookup", "result": { "output": "original-result" } } }
      [wire] context.append_loop_event   { "event": { "type": "tool.result", "parentUuid": "<uuid-4>", "toolCallId": "call_lookup", "result": { "output": "original-result" } }, "time": "<time>" }
      [emit] context.append_loop_event   { "time": "<time>", "event": { "type": "step.end", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "finishReason": "tool_use", "usage": { "inputOther": 9, "output": 17, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-1", "providerFinishReason": "tool_calls", "rawFinishReason": "tool_calls" } }
      [emit] turn.step.completed         { "time": "<time>", "turnId": 0, "step": 1, "stepId": "<uuid-2>", "usage": { "inputOther": 9, "output": 17, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use", "providerFinishReason": "tool_calls", "rawFinishReason": "tool_calls" }
      [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "finishReason": "tool_use", "usage": { "inputOther": 9, "output": 17, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-1", "providerFinishReason": "tool_calls", "rawFinishReason": "tool_calls" }, "time": "<time>" }
      [emit] turn.step.started           { "time": "<time>", "turnId": 0, "step": 2, "stepId": "<uuid-5>" }
      [emit] agent.activity.updated      { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 2, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [emit] context.append_loop_event   { "time": "<time>", "event": { "type": "step.begin", "uuid": "<uuid-5>", "turnId": "0", "step": 2 } }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-5>", "turnId": "0", "step": 2 }, "time": "<time>" }
      [wire] llm.tools_snapshot          { "hash": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", "tools": [], "time": "<time>" }
      [wire] llm.request                 { "kind": "loop", "provider": "openai", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 1000000, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "systemPrompt": "You are a deterministic test agent.", "toolsHash": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", "messageCount": 3, "turnStep": "0.2", "time": "<time>" }
      [emit] assistant.delta             { "time": "<time>", "turnId": 0, "step": 2, "stepId": "<uuid-5>", "partId": "<uuid-6>", "delta": "Still using the original turn config." }
      [emit] agent.activity.updated      { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "streaming", "stream": "assistant", "step": 2, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 31, "output": 13, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "turnId": 0, "agentId": "main", "provider": "test-provider", "modelAlias": "mock-model", "executorId": "native", "usageKnown": true, "time": "<time>" }
      [emit] agent.status.updated        { "time": "<time>", "usage": { "byModel": { "mock-model": { "inputOther": 40, "output": 30, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 40, "output": 30, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 40, "output": 30, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] token_counting.measured     { "length": 4, "tokens": 44, "time": "<time>" }
      [emit] agent.status.updated        { "time": "<time>", "contextTokens": 44 }
      [emit] context.append_loop_event   { "time": "<time>", "event": { "type": "content.part", "uuid": "<uuid-6>", "turnId": "0", "step": 2, "stepUuid": "<uuid-5>", "part": { "type": "text", "text": "Still using the original turn config." } } }
      [emit] context.append_loop_event   { "time": "<time>", "event": { "type": "step.end", "uuid": "<uuid-5>", "turnId": "0", "step": 2, "finishReason": "end_turn", "usage": { "inputOther": 31, "output": 13, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-2", "providerFinishReason": "completed", "rawFinishReason": "stop" } }
      [emit] turn.step.completed         { "time": "<time>", "turnId": 0, "step": 2, "stepId": "<uuid-5>", "usage": { "inputOther": 31, "output": 13, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn", "providerFinishReason": "completed", "rawFinishReason": "stop" }
      [emit] agent.activity.updated      { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 2, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-6>", "turnId": "0", "step": 2, "stepUuid": "<uuid-5>", "part": { "type": "text", "text": "Still using the original turn config." } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-5>", "turnId": "0", "step": 2, "finishReason": "end_turn", "usage": { "inputOther": 31, "output": 13, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-2", "providerFinishReason": "completed", "rawFinishReason": "stop" }, "time": "<time>" }
      [wire] turn.ended                  { "turnId": 0, "reason": "completed", "time": "<time>" }
      [emit] turn.ended                  { "time": "<time>", "turnId": 0, "reason": "completed" }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      tools: []
      messages:
        <last>
        assistant: text "I will look it up."  calls call_lookup:Lookup { "query": "original" }
        tool[call_lookup]: text "original-result"
    `);

    ctx.mockNextResponse({ type: 'text', text: 'Now the changed config is active.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Start a fresh turn' }] });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [emit] agent.activity.updated      { "time": "<time>", "lifecycle": "ready", "lastTurn": { "turnId": 0, "reason": "completed", "at": "<time>" }, "background": [] }
      [emit] prompt.completed            { "time": "<time>", "promptId": "<msg-1>", "finishedAt": "<time>", "reason": "completed" }
      [wire] prompt.completed            { "promptId": "<msg-1>", "finishedAt": "<time>", "reason": "completed", "time": "<time>" }
      [wire] prompt.accepted             { "promptId": "<msg-2>", "time": "<time>" }
      [emit] prompt.submitted            { "time": "<time>", "agentId": "main", "promptId": "<msg-2>", "userMessageId": "<msg-2>", "status": "running", "content": [ { "type": "text", "text": "Start a fresh turn" } ], "createdAt": "<time>", "appendTiming": "agent_idle", "revision": 0 }
      [wire] prompt.enqueued             { "schemaVersion": 1, "promptId": "<msg-2>", "userMessageId": "<msg-2>", "createdAt": "<time>", "message": { "role": "user", "content": [ { "type": "text", "text": "Start a fresh turn" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-2>" }, "alreadyMaterialized": false, "appendTiming": "agent_idle", "revision": 0, "queueIndex": 0, "time": "<time>" }
      [wire] prompt.launch_committed     { "launchId": "<uuid-7>", "promptId": "<msg-2>", "revision": 0, "committedAt": "<time>", "time": "<time>" }
      [emit] turn.prompt                 { "time": "<time>", "turnId": 1, "promptId": "<msg-2>", "input": [ { "type": "text", "text": "Start a fresh turn" } ], "origin": { "kind": "user" } }
      [emit] turn.started                { "time": "<time>", "turnId": 1, "origin": { "kind": "user" }, "prompt": "Start a fresh turn", "promptId": "<msg-2>" }
      [emit] agent.activity.updated      { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 1, "origin": { "kind": "user" }, "phase": "running", "step": 0, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [emit] context.spliced             { "time": "<time>", "start": 4, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Start a fresh turn" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-2>" } ] }
      [emit] prompt.started              { "time": "<time>", "agentId": "main", "promptId": "<msg-2>" }
      [wire] turn.prompt                 { "turnId": 1, "promptId": "<msg-2>", "input": [ { "type": "text", "text": "Start a fresh turn" } ], "origin": { "kind": "user" }, "time": "<time>" }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Start a fresh turn" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-2>" }, "time": "<time>" }
      [emit] turn.step.started           { "time": "<time>", "turnId": 1, "step": 1, "stepId": "<uuid-8>" }
      [emit] agent.activity.updated      { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 1, "origin": { "kind": "user" }, "phase": "running", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [emit] context.append_loop_event   { "time": "<time>", "event": { "type": "step.begin", "uuid": "<uuid-8>", "turnId": "1", "step": 1 } }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-8>", "turnId": "1", "step": 1 }, "time": "<time>" }
      [wire] llm.request                 { "kind": "loop", "provider": "openai", "model": "changed-model", "modelAlias": "changed-model", "thinkingEffort": "off", "maxTokens": 1000000, "toolSelect": false, "systemPromptHash": "7617cb8b42659214c397a1d7505fce204b673b078a10de8bcccc697d88dcda56", "toolsHash": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", "messageCount": 5, "turnStep": "1.1", "time": "<time>" }
      [emit] assistant.delta             { "time": "<time>", "turnId": 1, "step": 1, "stepId": "<uuid-8>", "partId": "<uuid-9>", "delta": "Now the changed config is active." }
      [emit] agent.activity.updated      { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 1, "origin": { "kind": "user" }, "phase": "streaming", "stream": "assistant", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [wire] usage.record                { "model": "changed-model", "usage": { "inputOther": 50, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "turnId": 1, "agentId": "main", "provider": "test-provider", "modelAlias": "changed-model", "executorId": "native", "usageKnown": true, "time": "<time>" }
      [emit] agent.status.updated        { "time": "<time>", "usage": { "byModel": { "mock-model": { "inputOther": 40, "output": 30, "inputCacheRead": 0, "inputCacheCreation": 0 }, "changed-model": { "inputOther": 50, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 90, "output": 42, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 50, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] token_counting.measured     { "length": 6, "tokens": 62, "time": "<time>" }
      [emit] agent.status.updated        { "time": "<time>", "contextTokens": 62 }
      [emit] context.append_loop_event   { "time": "<time>", "event": { "type": "content.part", "uuid": "<uuid-9>", "turnId": "1", "step": 1, "stepUuid": "<uuid-8>", "part": { "type": "text", "text": "Now the changed config is active." } } }
      [emit] context.append_loop_event   { "time": "<time>", "event": { "type": "step.end", "uuid": "<uuid-8>", "turnId": "1", "step": 1, "finishReason": "end_turn", "usage": { "inputOther": 50, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-3", "providerFinishReason": "completed", "rawFinishReason": "stop" } }
      [emit] turn.step.completed         { "time": "<time>", "turnId": 1, "step": 1, "stepId": "<uuid-8>", "usage": { "inputOther": 50, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn", "providerFinishReason": "completed", "rawFinishReason": "stop" }
      [emit] agent.activity.updated      { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 1, "origin": { "kind": "user" }, "phase": "running", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-9>", "turnId": "1", "step": 1, "stepUuid": "<uuid-8>", "part": { "type": "text", "text": "Now the changed config is active." } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-8>", "turnId": "1", "step": 1, "finishReason": "end_turn", "usage": { "inputOther": 50, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-3", "providerFinishReason": "completed", "rawFinishReason": "stop" }, "time": "<time>" }
      [wire] turn.ended                  { "turnId": 1, "reason": "completed", "time": "<time>" }
      [emit] turn.ended                  { "time": "<time>", "turnId": 1, "reason": "completed" }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: "Changed system prompt."
      messages:
        <last>
        assistant: text "Still using the original turn config."
        user: text "Start a fresh turn"
    `);
  });
});

describe('ConfigService env overlay (live)', () => {
  it('re-applies env bindings on every get()', async () => {
    const env: Record<string, string> = { KIMI_DISABLE_CRON: '0' };
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;

    expect(config.get<CronConfig>('cron').disabled).toBe(false);
    env['KIMI_DISABLE_CRON'] = '1';
    expect(config.get<CronConfig>('cron').disabled).toBe(true);
    env['KIMI_DISABLE_CRON'] = '0';
    expect(config.get<CronConfig>('cron').disabled).toBe(false);

    disposables.dispose();
  });

  it('reuses the effective config across get() calls until an observed env var changes', async () => {
    const env: Record<string, string> = { KIMI_DISABLE_CRON: '0' };
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;

    const first = config.get<CronConfig>('cron');
    expect(config.get<CronConfig>('cron')).toBe(first);
    expect(config.get<CronConfig>('cron')).toBe(first);

    env['KIMI_DISABLE_CRON'] = '1';
    const changed = config.get<CronConfig>('cron');
    expect(changed).not.toBe(first);
    expect(changed.disabled).toBe(true);
    expect(config.get<CronConfig>('cron')).toBe(changed);

    await config.replace('cron', { disabled: false });
    delete env['KIMI_DISABLE_CRON'];
    expect(config.get<CronConfig>('cron').disabled).toBe(false);

    disposables.dispose();
  });

  it('applies a scalar section env binding and keeps it out of the file', async () => {
    const env: Record<string, string> = {};
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;

    expect(config.get(BUILTIN_PRODUCT_SKILLS_SECTION)).toBe(true);

    env['KIKI_BUILTIN_PRODUCT_SKILLS'] = '0';
    expect(config.get(BUILTIN_PRODUCT_SKILLS_SECTION)).toBe(false);

    await config.replace(BUILTIN_PRODUCT_SKILLS_SECTION, true);
    delete env['KIKI_BUILTIN_PRODUCT_SKILLS'];
    expect(config.get(BUILTIN_PRODUCT_SKILLS_SECTION)).toBe(true);

    disposables.dispose();
  });

  it('keeps the file value when a scalar section env value fails to parse', async () => {
    const env: Record<string, string> = {};
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;
    await config.replace(BUILTIN_PRODUCT_SKILLS_SECTION, false);

    for (const invalid of ['', '   ', 'maybe']) {
      env['KIKI_BUILTIN_PRODUCT_SKILLS'] = invalid;
      expect(config.get(BUILTIN_PRODUCT_SKILLS_SECTION)).toBe(false);
    }

    env['KIKI_BUILTIN_PRODUCT_SKILLS'] = 'on';
    expect(config.get(BUILTIN_PRODUCT_SKILLS_SECTION)).toBe(true);

    disposables.dispose();
  });

  it('keeps the Kimi effort force separate from the configured effort', async () => {
    const env: Record<string, string> = { KIMI_MODEL_THINKING_EFFORT: 'max' };
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;
    await config.set(THINKING_SECTION, { effort: 'low' });

    expect(config.get<ThinkingConfig>(THINKING_SECTION)).toEqual({
      effort: 'low',
      forcedEffort: 'max',
    });

    disposables.dispose();
  });

  it('strips the Kimi effort force before persisting thinking config', async () => {
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg'));
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;

    await config.set(THINKING_SECTION, { effort: 'low', forcedEffort: 'max' });

    expect(config.inspect<ThinkingConfig>(THINKING_SECTION).userValue).toEqual({
      effort: 'low',
    });

    disposables.dispose();
  });

  it('deletes a scalar section on replace(undefined) — set(undefined) cannot', async () => {
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg'));
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;

    await config.replace('defaultModel', 'kimi-code/kimi-k2');
    expect(config.get<string>('defaultModel')).toBe('kimi-code/kimi-k2');

    await config.set('defaultModel', undefined);
    expect(config.get<string>('defaultModel')).toBe('kimi-code/kimi-k2');

    await config.replace('defaultModel', undefined);
    expect(config.get<string>('defaultModel')).toBeUndefined();

    disposables.dispose();
  });
});

describe('nb_search config section', () => {
  function createConfig(): { config: IConfigService; disposables: DisposableStore } {
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg'));
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    return { config: ix.get(IConfigService), disposables };
  }

  it('round-trips canonical provider, credential, lane, default, and execution settings', async () => {
    const { config, disposables } = createConfig();
    await config.ready;
    const value = {
      provider_instances: {
        'exa.team': {
          provider_id: 'exa',
          enabled: true,
          credential_slot_id: 'exa.team',
          options: {},
        },
      },
      credential_slots: { 'exa.team': { provider_id: 'exa', env: 'TEAM_EXA_API_KEY' } },
      lanes: {
        'team.search': {
          provider_instance_id: 'exa.team',
          operation_id: 'search',
          latency: 'fast',
          cost: 'cheap',
        },
      },
      defaults: { search_lane: 'team.search' },
      execution: { search_timeout_ms: 15_000, fetch_timeout_ms: 20_000 },
    };

    await config.set(NB_SEARCH_SECTION, value);

    expect(config.get<NbSearchConfig>(NB_SEARCH_SECTION)).toEqual(value);
    expect(config.inspect<NbSearchConfig>(NB_SEARCH_SECTION).userValue).toEqual(value);
    disposables.dispose();
  });

  it('applies canonical null deletion without persisting secret values', async () => {
    const { config, disposables } = createConfig();
    await config.ready;
    await config.set(NB_SEARCH_SECTION, {
      credential_slots: { team: { provider_id: 'exa', env: 'TEAM_EXA_API_KEY' } },
      defaults: { search_lane: 'exa.search' },
    });
    await config.set(NB_SEARCH_SECTION, { defaults: { search_lane: null } });

    expect(config.get<NbSearchConfig>(NB_SEARCH_SECTION)).toEqual({
      credential_slots: { team: { provider_id: 'exa', env: 'TEAM_EXA_API_KEY' } },
      defaults: {},
    });
    expect(JSON.stringify(config.get(NB_SEARCH_SECTION))).not.toContain('secret-value');
    disposables.dispose();
  });

  it('rejects credential values in the config domain', async () => {
    const { config, disposables } = createConfig();
    await config.ready;

    await expect(
      config.set(NB_SEARCH_SECTION, {
        credential_slots: { team: { provider_id: 'exa', env: 'TEAM_EXA_API_KEY', value: 'secret-value' } },
      }),
    ).rejects.toThrow('Invalid nb_search configuration');
    disposables.dispose();
  });

  it('accepts descriptor options and atomically rejects inline secret options', async () => {
    const { config, disposables } = createConfig();
    await config.ready;
    await config.set(NB_SEARCH_SECTION, {
      provider_instances: {
        'openai-compatible.default': { options: { model: 'example-model' } },
      },
    });

    await expect(
      config.set(NB_SEARCH_SECTION, {
        provider_instances: {
          unknown: { provider_id: 'unknown-provider', enabled: true, options: {} },
        },
      }),
    ).rejects.toThrow('Invalid nb_search configuration');
    await expect(
      config.set(NB_SEARCH_SECTION, {
        provider_instances: {
          'openai-compatible.default': { options: { api_key: 'secret-value' } },
        },
      }),
    ).rejects.toThrow('Invalid nb_search configuration');
    expect(config.inspect<NbSearchConfig>(NB_SEARCH_SECTION).userValue).toEqual({
      provider_instances: {
        'openai-compatible.default': { options: { model: 'example-model' } },
      },
    });
    expect(JSON.stringify(config.get(NB_SEARCH_SECTION))).not.toContain('secret-value');
    disposables.dispose();
  });
});

describe('skill config sections', () => {
  it('registers defaults for extraSkillDirs and mergeAllAvailableSkills', () => {
    const registry = new ConfigRegistry();

    expect(registry.getSection(EXTRA_SKILL_DIRS_SECTION)?.defaultValue).toEqual([]);
    expect(registry.getSection(MERGE_ALL_AVAILABLE_SKILLS_SECTION)?.defaultValue).toBe(true);
  });
});

describe('threadCommunication config section', () => {
  it('is globally disabled until an operator opts in', () => {
    const registry = new ConfigRegistry();

    expect(registry.getSection(THREAD_COMMUNICATION_SECTION)?.defaultValue).toEqual({
      enabled: false,
    });
    expect(
      registry.validate<ThreadCommunicationConfig>(THREAD_COMMUNICATION_SECTION, {}),
    ).toEqual({ enabled: false });
  });
});

describe('defaultPermissionMode config section', () => {
  it('registers the defaultPermissionMode section and not a yolo domain', () => {
    const registry = new ConfigRegistry();

    const section = registry.getSection(DEFAULT_PERMISSION_MODE_SECTION);
    expect(section).toBeDefined();
    expect(registry.validate(DEFAULT_PERMISSION_MODE_SECTION, 'auto')).toBe('auto');
    expect(registry.validate(DEFAULT_PERMISSION_MODE_SECTION, 'yolo')).toBe('yolo');
    expect(() => registry.validate(DEFAULT_PERMISSION_MODE_SECTION, 'bogus')).toThrow();

    expect(registry.getSection('yolo')).toBeUndefined();
  });
});

describe('image config section', () => {
  it('registers the image section with an empty default and a positive-int schema', () => {
    const registry = new ConfigRegistry();

    const section = registry.getSection(IMAGE_SECTION);
    expect(section).toBeDefined();
    expect(section?.defaultValue).toEqual({});

    expect(registry.validate(IMAGE_SECTION, {})).toEqual({});
    expect(
      registry.validate(IMAGE_SECTION, { maxEdgePx: 1500, readByteBudget: 131072 }),
    ).toEqual({ maxEdgePx: 1500, readByteBudget: 131072 });
    expect(registry.validate(IMAGE_SECTION, { maxEdgePx: 1500 })).toEqual({ maxEdgePx: 1500 });
    expect(() => registry.validate(IMAGE_SECTION, { maxEdgePx: 0 })).toThrow();
    expect(() => registry.validate(IMAGE_SECTION, { readByteBudget: 1.5 })).toThrow();
  });

  it('re-applies image env bindings on every get() and ignores invalid env', async () => {
    const env: Record<string, string> = {};
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;

    expect(config.get<ImageConfig>(IMAGE_SECTION)).toEqual({});

    env['KIMI_IMAGE_MAX_EDGE_PX'] = 'abc';
    env['KIMI_IMAGE_READ_BYTE_BUDGET'] = '-1';
    expect(config.get<ImageConfig>(IMAGE_SECTION)).toEqual({});

    env['KIMI_IMAGE_MAX_EDGE_PX'] = '1500';
    env['KIMI_IMAGE_READ_BYTE_BUDGET'] = '131072';
    expect(config.get<ImageConfig>(IMAGE_SECTION)).toEqual({
      maxEdgePx: 1500,
      readByteBudget: 131072,
    });

    env['KIMI_IMAGE_MAX_EDGE_PX'] = '2500';
    expect(config.get<ImageConfig>(IMAGE_SECTION).maxEdgePx).toBe(2500);

    disposables.dispose();
  });

  it('restores env-owned fields to the raw value on set() while the env var is set', async () => {
    const env: Record<string, string> = { 'KIMI_IMAGE_MAX_EDGE_PX': '1500' };
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    await storage.write(
      '',
      'config.toml',
      new TextEncoder().encode('[image]\nread_byte_budget = 131072\n'),
    );
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;

    await config.set(IMAGE_SECTION, { maxEdgePx: 1500, readByteBudget: 262144 });

    expect(config.get<ImageConfig>(IMAGE_SECTION)).toEqual({
      maxEdgePx: 1500,
      readByteBudget: 262144,
    });
    expect(config.inspect<ImageConfig>(IMAGE_SECTION).userValue).toEqual({
      readByteBudget: 262144,
    });

    disposables.dispose();
  });
});

describe('tokenCounting config section', () => {
  it('registers the tokenCounting section with the mixed strategy as default', () => {
    const registry = new ConfigRegistry();

    const section = registry.getSection(TOKEN_COUNTING_SECTION);
    expect(section).toBeDefined();
    expect(section?.defaultValue).toEqual({ strategy: 'measured+estimated' });

    expect(registry.validate(TOKEN_COUNTING_SECTION, { strategy: 'measured' })).toEqual({
      strategy: 'measured',
    });
    expect(registry.validate(TOKEN_COUNTING_SECTION, { strategy: 'estimated' })).toEqual({
      strategy: 'estimated',
    });
    expect(() => registry.validate(TOKEN_COUNTING_SECTION, { strategy: 'bogus' })).toThrow();
    expect(() => registry.validate(TOKEN_COUNTING_SECTION, {})).toThrow();
  });

  it('re-applies the env override on every get() and ignores invalid values', async () => {
    const env: Record<string, string> = {};
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;

    expect(config.get<TokenCountingConfig>(TOKEN_COUNTING_SECTION)).toEqual({
      strategy: 'measured+estimated',
    });

    env[TOKEN_COUNTING_STRATEGY_ENV] = 'bogus';
    expect(config.get<TokenCountingConfig>(TOKEN_COUNTING_SECTION)).toEqual({
      strategy: 'measured+estimated',
    });

    env[TOKEN_COUNTING_STRATEGY_ENV] = 'measured';
    expect(config.get<TokenCountingConfig>(TOKEN_COUNTING_SECTION)).toEqual({
      strategy: 'measured',
    });

    env[TOKEN_COUNTING_STRATEGY_ENV] = 'estimated';
    expect(config.get<TokenCountingConfig>(TOKEN_COUNTING_SECTION)).toEqual({
      strategy: 'estimated',
    });

    disposables.dispose();
  });
});

describe('loopControl config section', () => {
  it('registers the loopControl section with a non-negative-int schema and soft-cap default', () => {
    const registry = new ConfigRegistry();

    const section = registry.getSection(LOOP_CONTROL_SECTION);
    expect(section).toBeDefined();
    expect(registry.defaultValue(LOOP_CONTROL_SECTION)).toEqual({
      compactionSoftContextSize: DEFAULT_COMPACTION_SOFT_CONTEXT_SIZE,
    });

    expect(registry.validate(LOOP_CONTROL_SECTION, {})).toEqual({});
    expect(
      registry.validate(LOOP_CONTROL_SECTION, {
        maxStepsPerTurn: 100,
        maxAttemptsPerStep: 3,
        compactionSoftContextSize: 512_000,
      }),
    ).toEqual({
      maxStepsPerTurn: 100,
      maxAttemptsPerStep: 3,
      compactionSoftContextSize: 512_000,
    });
    expect(() => registry.validate(LOOP_CONTROL_SECTION, { maxStepsPerTurn: -1 })).toThrow();
    expect(() => registry.validate(LOOP_CONTROL_SECTION, { maxAttemptsPerStep: 1.5 })).toThrow();
    expect(registry.validate(LOOP_CONTROL_SECTION, { compactionMaxAttempts: 8 })).toEqual({
      compactionMaxAttempts: 8,
    });
    expect(() => registry.validate(LOOP_CONTROL_SECTION, { compactionMaxAttempts: 0 })).toThrow();
    expect(() =>
      registry.validate(LOOP_CONTROL_SECTION, { compactionSoftContextSize: -1 }),
    ).toThrow();
  });

  it('re-applies loopControl env bindings on every get() and ignores invalid env', async () => {
    const env: Record<string, string> = {};
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;

    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION)).toEqual({
      compactionSoftContextSize: DEFAULT_COMPACTION_SOFT_CONTEXT_SIZE,
    });

    env[LOOP_MAX_STEPS_PER_TURN_ENV] = 'abc';
    env[LOOP_MAX_ATTEMPTS_PER_STEP_ENV] = '-1';
    env[LOOP_COMPACTION_SOFT_CONTEXT_SIZE_ENV] = '-1';
    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION)).toEqual({
      compactionSoftContextSize: DEFAULT_COMPACTION_SOFT_CONTEXT_SIZE,
    });

    env[LOOP_MAX_STEPS_PER_TURN_ENV] = '100';
    env[LOOP_MAX_ATTEMPTS_PER_STEP_ENV] = '3';
    env[LOOP_COMPACTION_SOFT_CONTEXT_SIZE_ENV] = '512000';
    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION)).toEqual({
      maxStepsPerTurn: 100,
      maxAttemptsPerStep: 3,
      compactionSoftContextSize: 512_000,
    });

    env[LOOP_MAX_STEPS_PER_TURN_ENV] = '50';
    env[LOOP_COMPACTION_SOFT_CONTEXT_SIZE_ENV] = '0';
    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION)).toMatchObject({
      maxStepsPerTurn: 50,
      compactionSoftContextSize: 0,
    });

    disposables.dispose();
  });

  it('restores env-owned fields to the raw value on set() while the env var is set', async () => {
    const env: Record<string, string> = {
      [LOOP_MAX_STEPS_PER_TURN_ENV]: '7',
      [LOOP_MAX_ATTEMPTS_PER_STEP_ENV]: '2',
      [LOOP_COMPACTION_SOFT_CONTEXT_SIZE_ENV]: '512000',
    };
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    await storage.write(
      '',
      'config.toml',
      new TextEncoder().encode('[loop_control]\nmax_steps_per_turn = 100\n'),
    );
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;

    await config.set(LOOP_CONTROL_SECTION, {
      maxStepsPerTurn: 7,
      maxAttemptsPerStep: 2,
      reservedContextSize: 5000,
      compactionSoftContextSize: 512_000,
    });

    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION)).toEqual({
      maxStepsPerTurn: 7,
      maxAttemptsPerStep: 2,
      reservedContextSize: 5000,
      compactionSoftContextSize: 512_000,
    });
    expect(config.inspect<LoopControl>(LOOP_CONTROL_SECTION).userValue).toEqual({
      maxStepsPerTurn: 100,
      reservedContextSize: 5000,
    });
    const onDisk = new TextDecoder().decode(await storage.read('', 'config.toml'));
    expect(onDisk).toContain('max_steps_per_turn = 100');
    expect(onDisk).toContain('reserved_context_size = 5000');
    expect(onDisk).not.toContain('max_attempts_per_step');
    expect(onDisk).not.toContain('compaction_soft_context_size');

    disposables.dispose();
  });

  it('persists env-bound fields normally when no env var is set', async () => {
    const env: Record<string, string> = {};
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;

    await config.set(LOOP_CONTROL_SECTION, { maxStepsPerTurn: 50 });

    expect(config.inspect<LoopControl>(LOOP_CONTROL_SECTION).userValue).toEqual({
      maxStepsPerTurn: 50,
    });

    disposables.dispose();
  });

  it('does not strip a field whose env value fails to parse', async () => {
    const env: Record<string, string> = { [LOOP_MAX_STEPS_PER_TURN_ENV]: 'abc' };
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;

    await config.set(LOOP_CONTROL_SECTION, { maxStepsPerTurn: 50 });

    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION).maxStepsPerTurn).toBe(50);
    expect(config.inspect<LoopControl>(LOOP_CONTROL_SECTION).userValue).toEqual({
      maxStepsPerTurn: 50,
    });

    disposables.dispose();
  });

  it('recomputes env bindings from the env-free base when the env value degrades or is unset', async () => {
    const env: Record<string, string> = {};
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    await storage.write(
      '',
      'config.toml',
      new TextEncoder().encode('[loop_control]\nmax_steps_per_turn = 100\n'),
    );
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;

    env[LOOP_MAX_STEPS_PER_TURN_ENV] = '7';
    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION).maxStepsPerTurn).toBe(7);

    env[LOOP_MAX_STEPS_PER_TURN_ENV] = 'abc';
    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION).maxStepsPerTurn).toBe(100);

    env[LOOP_MAX_STEPS_PER_TURN_ENV] = '9';
    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION).maxStepsPerTurn).toBe(9);

    delete env[LOOP_MAX_STEPS_PER_TURN_ENV];
    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION).maxStepsPerTurn).toBe(100);

    env[LOOP_MAX_STEPS_PER_TURN_ENV] = '7';
    expect(config.getAll()[LOOP_CONTROL_SECTION]).toEqual({ maxStepsPerTurn: 7 });
    delete env[LOOP_MAX_STEPS_PER_TURN_ENV];
    expect(config.getAll()[LOOP_CONTROL_SECTION]).toEqual({ maxStepsPerTurn: 100 });

    disposables.dispose();
  });

  it('warns and ignores the deprecated max_steps_per_run key without rewriting the file', async () => {
    const env: Record<string, string> = { [LOOP_MAX_STEPS_PER_TURN_ENV]: '7' };
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    await storage.write(
      '',
      'config.toml',
      new TextEncoder().encode('[loop_control]\nmax_steps_per_run = 100\n'),
    );
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;

    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION)).toEqual({ maxStepsPerTurn: 7 });
    expect(config.inspect<LoopControl>(LOOP_CONTROL_SECTION).userValue).toEqual({
      maxStepsPerRun: 100,
    });
    expect(config.diagnostics()).toContainEqual({
      domain: LOOP_CONTROL_SECTION,
      severity: 'warning',
      message:
        "[loop_control] 'max_steps_per_run' is deprecated and no longer used; rename it to 'max_steps_per_turn'. Run /kiki-ops fix this configuration warning.",
    });
    await config.set(LOOP_CONTROL_SECTION, { maxStepsPerTurn: 7 });
    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION).maxStepsPerTurn).toBe(7);
    const onDisk = new TextDecoder().decode(await storage.read('', 'config.toml'));
    expect(onDisk).toContain('max_steps_per_run = 100');

    disposables.dispose();
  });

  it('preserves unknown on-disk fields across repeated stripped writes', async () => {
    const env: Record<string, string> = { [LOOP_MAX_STEPS_PER_TURN_ENV]: '7' };
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    await storage.write(
      '',
      'config.toml',
      new TextEncoder().encode('[loop_control]\nfuture_field = 1\n'),
    );
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;

    await config.set(LOOP_CONTROL_SECTION, { maxStepsPerTurn: 7 });
    await config.set(LOOP_CONTROL_SECTION, { maxStepsPerTurn: 7 });

    const onDisk = new TextDecoder().decode(await storage.read('', 'config.toml'));
    expect(onDisk).toContain('future_field = 1');
    expect(onDisk).not.toContain('max_steps_per_turn');
    expect(config.inspect<LoopControl>(LOOP_CONTROL_SECTION).userValue).toEqual({
      futureField: 1,
    });

    disposables.dispose();
  });

  it('rejects the write when the env-masked on-disk value is invalid', async () => {
    const env: Record<string, string> = { [LOOP_MAX_STEPS_PER_TURN_ENV]: '7' };
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    await storage.write(
      '',
      'config.toml',
      new TextEncoder().encode('[loop_control]\nmax_steps_per_turn = -1\n'),
    );
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;

    await expect(
      config.set(LOOP_CONTROL_SECTION, { maxStepsPerTurn: 7, reservedContextSize: 5000 }),
    ).rejects.toThrow();

    const onDisk = new TextDecoder().decode(await storage.read('', 'config.toml'));
    expect(onDisk).toContain('max_steps_per_turn = -1');
    expect(onDisk).not.toContain('reserved_context_size');

    disposables.dispose();
  });
});

describe('config deprecations', () => {
  async function createConfig(env: Record<string, string>, toml?: string) {
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    if (toml !== undefined) {
      await storage.write('', 'config.toml', new TextEncoder().encode(toml));
    }
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;
    return { config, disposables, storage };
  }

  it('parses and writes model service_tier while rejecting unknown tier values', async () => {
    const { config, disposables, storage } = await createConfig({}, '[models."example/fast"]\nmodel = "fast"\nservice_tier = "priority"\n');
    try {
      expect(config.get(MODELS_SECTION)).toMatchObject({ 'example/fast': { serviceTier: 'priority' } });
      await config.set(MODELS_SECTION, { 'example/fast': { model: 'fast', serviceTier: 'default' } });
      expect(new TextDecoder().decode(await storage.read('', 'config.toml'))).toContain('service_tier = "default"');
      await expect(config.set(MODELS_SECTION, { 'example/fast': { serviceTier: 'invalid' } })).rejects.toThrow();
    } finally {
      disposables.dispose();
    }
  });

  it('warns and ignores a deprecated TOML key whose value no longer applies', async () => {
    const { config, disposables } = await createConfig(
      {},
      '[loop_control]\nmax_retries_per_step = 3\n',
    );

    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION)).toEqual({});
    expect(config.diagnostics()).toContainEqual({
      domain: LOOP_CONTROL_SECTION,
      severity: 'warning',
      message:
        "[loop_control] 'max_retries_per_step' is deprecated and no longer used; rename it to 'max_attempts_per_step'. Run /kiki-ops fix this configuration warning.",
    });

    disposables.dispose();
  });

  it('lets the replacement key win when both are present, still warning', async () => {
    const { config, disposables } = await createConfig(
      {},
      '[loop_control]\nmax_retries_per_step = 3\nmax_attempts_per_step = 2\n',
    );

    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION)).toEqual({ maxAttemptsPerStep: 2 });
    expect(config.diagnostics()).toContainEqual({
      domain: LOOP_CONTROL_SECTION,
      severity: 'warning',
      message:
        "[loop_control] 'max_retries_per_step' is deprecated and no longer used; rename it to 'max_attempts_per_step'. Run /kiki-ops fix this configuration warning.",
    });

    disposables.dispose();
  });

  it('resolves a deprecated env var as a fallback with a warning, new var first', async () => {
    const env: Record<string, string> = { [LOOP_MAX_RETRIES_PER_STEP_ENV]: '4' };
    const { config, disposables } = await createConfig(env);

    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION)).toMatchObject({ maxAttemptsPerStep: 4 });
    expect(config.diagnostics()).toContainEqual({
      domain: LOOP_CONTROL_SECTION,
      severity: 'warning',
      message: `Environment variable ${LOOP_MAX_RETRIES_PER_STEP_ENV} is deprecated; use ${LOOP_MAX_ATTEMPTS_PER_STEP_ENV} instead.`,
    });
    env[LOOP_MAX_ATTEMPTS_PER_STEP_ENV] = '2';
    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION)).toMatchObject({ maxAttemptsPerStep: 2 });

    disposables.dispose();
  });

  it('reports no env deprecation when only the replacement var is set', async () => {
    const env: Record<string, string> = { [LOOP_MAX_ATTEMPTS_PER_STEP_ENV]: '4' };
    const { config, disposables } = await createConfig(env);

    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION)).toMatchObject({ maxAttemptsPerStep: 4 });
    expect(config.diagnostics()).toEqual([]);

    disposables.dispose();
  });

  it('keeps the deprecated env warning across a no-op reload', async () => {
    const env: Record<string, string> = { [LOOP_MAX_RETRIES_PER_STEP_ENV]: '4' };
    const { config, disposables } = await createConfig(env);

    const warning = {
      domain: LOOP_CONTROL_SECTION,
      severity: 'warning' as const,
      message: `Environment variable ${LOOP_MAX_RETRIES_PER_STEP_ENV} is deprecated; use ${LOOP_MAX_ATTEMPTS_PER_STEP_ENV} instead.`,
    };
    expect(config.diagnostics()).toContainEqual(warning);

    await config.reload();

    expect(config.diagnostics()).toContainEqual(warning);
    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION)).toMatchObject({ maxAttemptsPerStep: 4 });

    disposables.dispose();
  });

  it('restores the env-owned field on set() when only the deprecated env var is set', async () => {
    const env: Record<string, string> = { [LOOP_MAX_RETRIES_PER_STEP_ENV]: '2' };
    const { config, disposables, storage } = await createConfig(
      env,
      '[loop_control]\nmax_attempts_per_step = 9\n',
    );

    await config.set(LOOP_CONTROL_SECTION, { maxAttemptsPerStep: 2, reservedContextSize: 5000 });

    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION)).toEqual({
      maxAttemptsPerStep: 2,
      reservedContextSize: 5000,
    });
    expect(config.inspect<LoopControl>(LOOP_CONTROL_SECTION).userValue).toEqual({
      maxAttemptsPerStep: 9,
      reservedContextSize: 5000,
    });
    const onDisk = new TextDecoder().decode(await storage.read('', 'config.toml'));
    expect(onDisk).toContain('max_attempts_per_step = 9');

    disposables.dispose();
  });

  it('emits onDidChangeDiagnostics on load and again when the warning clears', async () => {
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    await storage.write(
      '',
      'config.toml',
      new TextEncoder().encode('[loop_control]\nmax_retries_per_step = 3\n'),
    );
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', {}));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    const emissions: Array<readonly unknown[]> = [];
    config.onDidChangeDiagnostics((diagnostics) => {
      emissions.push(diagnostics);
    });
    await config.ready;

    expect(emissions).toHaveLength(1);
    expect(emissions[0]).toContainEqual({
      domain: LOOP_CONTROL_SECTION,
      severity: 'warning',
      message:
        "[loop_control] 'max_retries_per_step' is deprecated and no longer used; rename it to 'max_attempts_per_step'. Run /kiki-ops fix this configuration warning.",
    });

    await storage.write(
      '',
      'config.toml',
      new TextEncoder().encode('[loop_control]\nmax_attempts_per_step = 3\n'),
    );
    await config.reload();

    expect(emissions).toHaveLength(2);
    expect(emissions[1]).toEqual([]);
    expect(config.diagnostics()).toEqual([]);
    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION)).toEqual({ maxAttemptsPerStep: 3 });

    disposables.dispose();
  });
});

describe('malformed models config entries', () => {
  async function createConfig(toml: string) {
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    await storage.write('', 'config.toml', new TextEncoder().encode(toml));
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', {}));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;
    return { config, disposables, storage };
  }

  it('warns at load time when a dotted alias parses as a nested table', async () => {
    const { config, disposables } = await createConfig(
      '[models.kimi-k2.7-code]\nmodel = "kimi-k2.7-code"\nmax_context_size = 262144\n',
    );

    expect(config.diagnostics()).toContainEqual({
      domain: 'models',
      severity: 'warning',
      message:
        "[models] entry 'kimi-k2' is missing the 'model' field and cannot be used as a model; " +
        'if the alias contains dots, quote the table name (e.g. [models."kimi-k2.7-code"]).',
    });

    disposables.dispose();
  });

  it('stays silent for quoted dotted aliases and entries with a wire-facing name', async () => {
    const { config, disposables } = await createConfig(
      '[models."kimi-k2.7-code"]\nmodel = "kimi-k2.7-code"\n\n[models.renamed]\nname = "wire-name"\n',
    );

    expect(config.diagnostics()).toEqual([]);

    disposables.dispose();
  });

  it('warns without the dotted-alias hint when the entry has no nested table', async () => {
    const { config, disposables } = await createConfig(
      '[models.partial]\nmax_context_size = 262144\n',
    );

    expect(config.diagnostics()).toContainEqual({
      domain: 'models',
      severity: 'warning',
      message:
        "[models] entry 'partial' is missing the 'model' field and cannot be used as a model.",
    });

    disposables.dispose();
  });

  it('does not mistake schema object fields for a dotted alias', async () => {
    const { config, disposables } = await createConfig(
      '[models.partial]\nrequest_identity = { policy = "default" }\n',
    );

    expect(config.diagnostics()).toContainEqual({
      domain: 'models',
      severity: 'warning',
      message:
        "[models] entry 'partial' is missing the 'model' field and cannot be used as a model.",
    });

    disposables.dispose();
  });

  it('clears the warning on reload once the entry is fixed', async () => {
    const { config, disposables, storage } = await createConfig(
      '[models.kimi-k2.7-code]\nmodel = "kimi-k2.7-code"\n',
    );
    expect(config.diagnostics()).toHaveLength(1);

    await storage.write(
      '',
      'config.toml',
      new TextEncoder().encode('[models."kimi-k2.7-code"]\nmodel = "kimi-k2.7-code"\n'),
    );
    await config.reload();

    expect(config.diagnostics()).toEqual([]);

    disposables.dispose();
  });
});

describe('entry-keyed section salvage', () => {
  async function createConfig(toml: string) {
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    await storage.write('', 'config.toml', new TextEncoder().encode(toml));
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg-entry-salvage', {}));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;
    const readText = async (): Promise<string> => {
      const bytes = await storage.read('', 'config.toml');
      if (bytes === undefined) throw new Error('config.toml missing');
      return new TextDecoder().decode(bytes);
    };
    return { config, disposables, storage, readText };
  }

  it('keeps the usable providers entries and names the invalid entry', async () => {
    const { config, disposables } = await createConfig(
      '[providers.acme]\ntype = "openai"\napi_key = "sk-acme"\n\n[providers.bad]\ntype = 123\n',
    );

    expect(config.get<Record<string, unknown>>(PROVIDERS_SECTION)).toEqual({
      acme: { type: 'openai', apiKey: 'sk-acme' },
    });
    expect(config.diagnostics()).toContainEqual({
      domain: PROVIDERS_SECTION,
      severity: 'warning',
      message: expect.stringContaining("Ignored invalid [providers] entry 'bad'"),
    });
    expect(
      config
        .diagnostics()
        .some((d) => d.message.includes("Ignored invalid config section 'providers'")),
    ).toBe(false);
    expect(config.inspect<Record<string, unknown>>(PROVIDERS_SECTION).userValue).toEqual({
      acme: { type: 'openai', apiKey: 'sk-acme' },
      bad: { type: 123 },
    });
    expect(config.inspect<Record<string, unknown>>(PROVIDERS_SECTION).value).toEqual({
      acme: { type: 'openai', apiKey: 'sk-acme' },
    });

    disposables.dispose();
  });

  it('keeps the usable models entries on reload and clears the warning once the entry is fixed', async () => {
    const { config, disposables, storage } = await createConfig(
      '[models."acme/m1"]\nprovider = "acme"\nmodel = "m1"\n\n' +
        '[models.bad]\nmodel = "m1"\nmax_context_size = "big"\n',
    );

    expect(config.get<Record<string, unknown>>(MODELS_SECTION)).toEqual({
      'acme/m1': { provider: 'acme', model: 'm1' },
    });
    expect(config.diagnostics()).toContainEqual({
      domain: MODELS_SECTION,
      severity: 'warning',
      message: expect.stringContaining("Ignored invalid [models] entry 'bad'"),
    });
    expect(config.inspect<Record<string, unknown>>(MODELS_SECTION).userValue).toEqual({
      'acme/m1': { provider: 'acme', model: 'm1' },
      bad: { model: 'm1', maxContextSize: 'big' },
    });

    await storage.write(
      '',
      'config.toml',
      new TextEncoder().encode(
        '[models."acme/m1"]\nprovider = "acme"\nmodel = "m1"\n\n' +
          '[models.bad]\nmodel = "m1"\nmax_context_size = 2000\n',
      ),
    );
    await config.reload();

    expect(config.diagnostics()).toEqual([]);
    expect(config.get<Record<string, unknown>>(MODELS_SECTION)).toEqual({
      'acme/m1': { provider: 'acme', model: 'm1' },
      bad: { model: 'm1', maxContextSize: 2000 },
    });

    disposables.dispose();
  });

  it('retains each last-good provider and model entry while applying valid sibling updates', async () => {
    const { config, disposables, storage } = await createConfig(
      '[providers.acme]\ntype = "openai"\nbase_url = "https://old.example.test"\n\n' +
        '[models."acme/m1"]\nprovider = "acme"\nmodel = "m1"\nmax_context_size = 1000\n',
    );

    await storage.write(
      '',
      'config.toml',
      new TextEncoder().encode(
        '[providers.acme]\ntype = 123\n\n[providers.next]\ntype = "openai"\n\n' +
          '[models."acme/m1"]\nprovider = "acme"\nmodel = "m1"\nmax_context_size = "bad"\n\n' +
          '[models."acme/m2"]\nprovider = "acme"\nmodel = "m2"\n',
      ),
    );
    await config.reload();

    expect(config.get<Record<string, unknown>>(PROVIDERS_SECTION)).toEqual({
      acme: { type: 'openai', baseUrl: 'https://old.example.test' },
      next: { type: 'openai' },
    });
    expect(config.get<Record<string, unknown>>(MODELS_SECTION)).toEqual({
      'acme/m1': { provider: 'acme', model: 'm1', maxContextSize: 1000 },
      'acme/m2': { provider: 'acme', model: 'm2' },
    });
    expect(config.diagnostics()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          domain: PROVIDERS_SECTION,
          message: expect.stringContaining(
            "Rejected invalid [providers] entry 'acme' and retained its last valid value",
          ),
        }),
        expect.objectContaining({
          domain: MODELS_SECTION,
          message: expect.stringContaining(
            "Rejected invalid [models] entry 'acme/m1' and retained its last valid value",
          ),
        }),
      ]),
    );

    disposables.dispose();
  });

  it('falls back to the section-level diagnostic when the section value is not a keyed record', async () => {
    const { config, disposables } = await createConfig('providers = "acme"\n');

    expect(config.get(PROVIDERS_SECTION)).toEqual({});
    expect(config.diagnostics()).toContainEqual({
      domain: PROVIDERS_SECTION,
      severity: 'warning',
      message: expect.stringContaining("Ignored invalid config section 'providers'"),
    });

    disposables.dispose();
  });

  it('still rejects writes that carry an invalid entry', async () => {
    const { config, disposables, readText } = await createConfig(
      '[providers.acme]\ntype = "openai"\napi_key = "sk-acme"\n',
    );

    await expect(config.set(PROVIDERS_SECTION, { bad: { type: 123 } })).rejects.toThrow();
    await expect(config.replace(PROVIDERS_SECTION, { bad: { type: 123 } })).rejects.toThrow();
    await expect(
      config.replaceSections({ [PROVIDERS_SECTION]: { bad: { type: 123 } } }),
    ).rejects.toThrow();

    expect(await readText()).toBe('[providers.acme]\ntype = "openai"\napi_key = "sk-acme"\n');
    expect(config.get<Record<string, unknown>>(PROVIDERS_SECTION)).toEqual({
      acme: { type: 'openai', apiKey: 'sk-acme' },
    });

    disposables.dispose();
  });

  it('keeps a salvaged-out entry on disk when another section is written', async () => {
    const { config, disposables, readText } = await createConfig(
      '[providers.bad]\ntype = 123\n\n[thinking]\nenabled = true\n',
    );

    await config.set(THINKING_SECTION, { enabled: false });

    expect(await readText()).toContain('type = 123');
    expect(config.get<ThinkingConfig>(THINKING_SECTION)).toEqual({ enabled: false });
    expect(config.get<Record<string, unknown>>(PROVIDERS_SECTION)).toEqual({});

    disposables.dispose();
  });
});

describe('retry config section', () => {
  async function createConfig(toml: string) {
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    await storage.write('', 'config.toml', new TextEncoder().encode(toml));
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', {}));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;
    const readText = async (): Promise<string> => {
      const bytes = await storage.read('', 'config.toml');
      if (bytes === undefined) throw new Error('config.toml missing');
      return new TextDecoder().decode(bytes);
    };
    return { config, disposables, readText };
  }

  it('loads policy entries written with snake_case keys', async () => {
    const { config, disposables } = await createConfig(
      '[retry]\nmax_attempts = 3\n\n[[retry.policies]]\nmatch = "provider.rate_limit"\n' +
        'max_attempts = 2\nbackoff = 1500\nretry = false\n',
    );

    expect(config.get<RetryConfig>(RETRY_SECTION)).toEqual({
      maxAttempts: 3,
      policies: [{ match: 'provider.rate_limit', maxAttempts: 2, backoff: 1500, retry: false }],
    });
    expect(config.diagnostics()).toEqual([]);

    disposables.dispose();
  });

  it.each([
    ['section', '[retry]\nmax_attempt = 3\n'],
    [
      'policy',
      '[[retry.policies]]\nmatch = "APIConnectionError"\nmax_attempt = 2\n',
    ],
  ])('rejects unknown keys in the retry %s loaded from TOML', async (_scope, toml) => {
    const { config, disposables } = await createConfig(toml);

    expect(config.get<RetryConfig>(RETRY_SECTION)).toBeUndefined();
    expect(config.diagnostics()).toContainEqual(
      expect.objectContaining({
        domain: RETRY_SECTION,
        severity: 'warning',
        message: expect.stringContaining("Ignored invalid config section 'retry'"),
      }),
    );

    disposables.dispose();
  });

  it('defaults a policy without an explicit retry flag to retrying', async () => {
    const { config, disposables } = await createConfig(
      '[[retry.policies]]\nmatch = "APIConnectionError"\n',
    );

    expect(config.get<RetryConfig>(RETRY_SECTION)).toEqual({
      policies: [{ match: 'APIConnectionError', retry: true }],
    });

    disposables.dispose();
  });

  it('accepts a single [retry.policies] table as one policy', async () => {
    const { config, disposables } = await createConfig(
      '[retry.policies]\nmatch = "APIConnectionError"\nmax_attempts = 2\n',
    );

    expect(config.get<RetryConfig>(RETRY_SECTION)).toEqual({
      policies: [{ match: 'APIConnectionError', maxAttempts: 2, retry: true }],
    });

    disposables.dispose();
  });

  it('warns at load time about a policy with an invalid match and keeps the other entries', async () => {
    const { config, disposables } = await createConfig(
      '[[retry.policies]]\nmatch = "("\nretry = false\n\n' +
        '[[retry.policies]]\nmatch = "APIConnectionError"\n',
    );

    expect(config.diagnostics()).toContainEqual({
      domain: RETRY_SECTION,
      severity: 'warning',
      message:
        '[retry] policies[0].match "(" is not a valid regular expression; that policy is ignored.',
    });
    expect(config.get<RetryConfig>(RETRY_SECTION)).toEqual({
      policies: [{ match: '(', retry: false }, { match: 'APIConnectionError', retry: true }],
    });

    disposables.dispose();
  });

  it('writes policy entries back to config.toml in snake_case', async () => {
    const { config, disposables, readText } = await createConfig('[retry]\nmax_attempts = 2\n');

    await config.set(RETRY_SECTION, {
      policies: [{ match: 'APIConnectionError', maxAttempts: 3, backoff: 200 }],
    });

    const onDisk = await readText();
    expect(onDisk).toContain('max_attempts = 2');
    expect(onDisk).toContain('[[retry.policies]]');
    expect(onDisk).toContain('max_attempts = 3');
    expect(onDisk).toContain('backoff = 200');
    expect(onDisk).not.toContain('maxAttempts');

    disposables.dispose();
  });
});

describe('removed config sections and keys', () => {
  async function createConfig(toml: string) {
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    await storage.write('', 'config.toml', new TextEncoder().encode(toml));
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', {}));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;
    return { config, disposables };
  }

  const bindingReplacement =
    'Subagent model and effort bindings come from the agent profile (or its route or the caller ' +
    'lease), or from an explicit model_alias and effort at dispatch. Run /kiki-ops fix this configuration warning.';

  it('warns about the removed secondary_model section instead of silently ignoring it', async () => {
    const { config, disposables } = await createConfig(
      '[secondary_model]\ndefault_model = "k3-max"\n',
    );

    expect(config.diagnostics()).toContainEqual({
      domain: 'secondaryModel',
      severity: 'warning',
      message: `[secondary_model] was removed and is no longer read. ${bindingReplacement}`,
    });

    disposables.dispose();
  });

  it('warns about removed subagent keys that the schema would silently drop', async () => {
    const { config, disposables } = await createConfig(
      '[subagent]\ndefault_model = "k3-max"\ndefault_effort = "high"\n',
    );

    expect(config.diagnostics()).toContainEqual({
      domain: 'subagent',
      severity: 'warning',
      message: `[subagent] 'default_model' was removed and is no longer read. ${bindingReplacement}`,
    });
    expect(config.diagnostics()).toContainEqual({
      domain: 'subagent',
      severity: 'warning',
      message: `[subagent] 'default_effort' was removed and is no longer read. ${bindingReplacement}`,
    });

    disposables.dispose();
  });

  it('warns about removed agents keys', async () => {
    const { config, disposables } = await createConfig(
      '[agents]\ndefault_subagent_model = "k3-max"\n',
    );

    expect(config.diagnostics()).toContainEqual({
      domain: 'agents',
      severity: 'warning',
      message: `[agents] 'default_subagent_model' was removed and is no longer read. ${bindingReplacement}`,
    });

    disposables.dispose();
  });

  it('stays silent when no removed key is present', async () => {
    const { config, disposables } = await createConfig(
      '[subagent]\ntimeout_ms = 60000\n',
    );

    expect(config.diagnostics()).toEqual([]);

    disposables.dispose();
  });
});

describe('task config section', () => {
  it('re-applies the keepAliveOnExit env binding on every get()', async () => {
    const env: Record<string, string> = {};
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;

    expect(config.get<AgentTaskConfig>('task')?.keepAliveOnExit).toBeUndefined();

    env[KEEP_ALIVE_ON_EXIT_ENV] = '1';
    expect(config.get<AgentTaskConfig>('task')?.keepAliveOnExit).toBe(true);
    env[KEEP_ALIVE_ON_EXIT_ENV] = '0';
    expect(config.get<AgentTaskConfig>('task')?.keepAliveOnExit).toBe(false);

    env[KEEP_ALIVE_ON_EXIT_ENV] = 'true';
    expect(config.get<AgentTaskConfig>('background')?.keepAliveOnExit).toBe(true);

    disposables.dispose();
  });

  it('preserves legacy task limits when the env binding creates a task overlay', async () => {
    const env: Record<string, string> = { [KEEP_ALIVE_ON_EXIT_ENV]: 'true' };
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    await storage.write(
      '',
      'config.toml',
      new TextEncoder().encode(
        '[background]\nmax_running_tasks = 3\nkill_grace_period_ms = 25\n',
      ),
    );
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;

    expect(resolveAgentTaskConfig(config)).toEqual({
      maxRunningTasks: 3,
      killGracePeriodMs: 25,
      keepAliveOnExit: true,
    });

    disposables.dispose();
  });

  it('re-applies the maxRunningTasks env binding on every get() and ignores invalid env', async () => {
    const env: Record<string, string> = {};
    const { config, disposables } = await createTaskConfig(env);

    expect(config.get<AgentTaskConfig>('task')?.maxRunningTasks).toBeUndefined();

    env[MAX_RUNNING_TASKS_ENV] = 'abc';
    expect(config.get<AgentTaskConfig>('task')?.maxRunningTasks).toBeUndefined();
    env[MAX_RUNNING_TASKS_ENV] = '0';
    expect(config.get<AgentTaskConfig>('task')?.maxRunningTasks).toBeUndefined();

    env[MAX_RUNNING_TASKS_ENV] = '4';
    expect(config.get<AgentTaskConfig>('task')?.maxRunningTasks).toBe(4);
    expect(config.get<AgentTaskConfig>('background')?.maxRunningTasks).toBe(4);

    env[MAX_RUNNING_TASKS_ENV] = '2';
    expect(config.get<AgentTaskConfig>('task')?.maxRunningTasks).toBe(2);

    disposables.dispose();
  });

  it('lets the maxRunningTasks env binding override the config value', async () => {
    const env: Record<string, string> = { [MAX_RUNNING_TASKS_ENV]: '8' };
    const { config, disposables } = await createTaskConfig(
      env,
      '[background]\nmax_running_tasks = 3\n',
    );

    expect(resolveAgentTaskConfig(config)?.maxRunningTasks).toBe(8);

    disposables.dispose();
  });

  it('restores env-owned fields to the raw value on set() while the env var is set', async () => {
    const env: Record<string, string> = {
      [KEEP_ALIVE_ON_EXIT_ENV]: 'true',
      [MAX_RUNNING_TASKS_ENV]: '8',
    };
    const { config, disposables } = await createTaskConfig(
      env,
      '[background]\nmax_running_tasks = 3\n',
    );

    await config.set('background', {
      keepAliveOnExit: true,
      maxRunningTasks: 8,
      killGracePeriodMs: 25,
    });

    expect(config.get<AgentTaskConfig>('background')).toEqual({
      keepAliveOnExit: true,
      maxRunningTasks: 8,
      killGracePeriodMs: 25,
    });
    expect(config.inspect<AgentTaskConfig>('background').userValue).toEqual({
      maxRunningTasks: 3,
      killGracePeriodMs: 25,
    });

    disposables.dispose();
  });

  it('does not strip a field whose env value fails to parse', async () => {
    const env: Record<string, string> = { [KEEP_ALIVE_ON_EXIT_ENV]: 'abc' };
    const { config, disposables } = await createTaskConfig(env);

    await config.set('background', { keepAliveOnExit: true });

    expect(config.get<AgentTaskConfig>('background')?.keepAliveOnExit).toBe(true);
    expect(config.inspect<AgentTaskConfig>('background').userValue).toEqual({
      keepAliveOnExit: true,
    });

    disposables.dispose();
  });

  async function createTaskConfig(env: Record<string, string>, toml?: string) {
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    if (toml !== undefined) {
      await storage.write('', 'config.toml', new TextEncoder().encode(toml));
    }
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;
    return { config, disposables };
  }

  it('parses print policy fields and merges legacy background with task overrides', async () => {
    const { config, disposables } = await createTaskConfig(
      {},
      '[background]\nprint_background_mode = "steer"\nprint_wait_ceiling_s = 60\n\n' +
        '[task]\nprint_max_turns = 5\n',
    );

    expect(resolveAgentTaskConfig(config)).toEqual({
      printBackgroundMode: 'steer',
      printWaitCeilingS: 60,
      printMaxTurns: 5,
    });

    disposables.dispose();
  });

  it('drops the task section with a warning when a print policy value is invalid', async () => {
    const { config, disposables } = await createTaskConfig(
      {},
      '[task]\nprint_background_mode = "wait"\n',
    );
    expect(config.get<AgentTaskConfig>('task')?.printBackgroundMode).toBeUndefined();
    expect(
      config
        .diagnostics()
        .some((d) => d.message.includes("Ignored invalid config section 'task'")),
    ).toBe(true);
    disposables.dispose();
  });

  it('resolvePrintBackgroundMode prefers the explicit mode over keepAliveOnExit', async () => {
    const { config, disposables } = await createTaskConfig(
      {},
      '[task]\nprint_background_mode = "exit"\nkeep_alive_on_exit = true\n',
    );
    expect(resolvePrintBackgroundMode(config)).toBe('exit');
    disposables.dispose();
  });

  it('resolvePrintBackgroundMode falls back to keepAliveOnExit then steer', async () => {
    const env: Record<string, string> = {};
    const { config, disposables } = await createTaskConfig(env);

    expect(resolvePrintBackgroundMode(config)).toBe('steer');

    env[KEEP_ALIVE_ON_EXIT_ENV] = 'true';
    expect(resolvePrintBackgroundMode(config)).toBe('drain');

    disposables.dispose();
  });
});

describe('applyPrintModeConfigDefaults', () => {
  async function createConfig(env: Record<string, string>, toml?: string) {
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    if (toml !== undefined) {
      await storage.write('', 'config.toml', new TextEncoder().encode(toml));
    }
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;
    return { config, disposables };
  }

  it('fills unset keys into the memory layer with effectively unbounded values', async () => {
    const { config, disposables } = await createConfig({});

    await applyPrintModeConfigDefaults(config);

    expect(resolveAgentTaskConfig(config)?.bashTaskTimeoutS).toBe(0);
    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION)?.maxStepsPerTurn).toBe(0);
    expect(resolveSubagentTimeoutMs(config)).toBe(0);
    expect(config.inspect('task').memoryValue).toMatchObject({ bashTaskTimeoutS: 0 });
    expect(config.inspect(LOOP_CONTROL_SECTION).memoryValue).toMatchObject({
      maxStepsPerTurn: 0,
    });
    expect(config.inspect('subagent').memoryValue).toMatchObject({ timeoutMs: 0 });

    disposables.dispose();
  });

  it('does not override keys the user set explicitly', async () => {
    const { config, disposables } = await createConfig(
      {},
      '[task]\nbash_task_timeout_s = 30\n\n' +
        '[loop_control]\nmax_steps_per_turn = 7\n\n' +
        '[subagent]\ntimeout_ms = 5000\n',
    );

    await applyPrintModeConfigDefaults(config);

    expect(resolveAgentTaskConfig(config)?.bashTaskTimeoutS).toBe(30);
    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION)?.maxStepsPerTurn).toBe(7);
    expect(resolveSubagentTimeoutMs(config)).toBe(5000);
    expect(config.inspect('task').memoryValue).toBeUndefined();
    expect(config.inspect(LOOP_CONTROL_SECTION).memoryValue).toBeUndefined();
    expect(config.inspect('subagent').memoryValue).toBeUndefined();

    disposables.dispose();
  });

  it('treats a legacy [background] bash_task_timeout_s as user-set', async () => {
    const { config, disposables } = await createConfig(
      {},
      '[background]\nbash_task_timeout_s = 15\n',
    );

    await applyPrintModeConfigDefaults(config);

    expect(resolveAgentTaskConfig(config)?.bashTaskTimeoutS).toBe(15);

    disposables.dispose();
  });

  it('keeps sibling user keys of a filled section visible', async () => {
    const { config, disposables } = await createConfig(
      {},
      '[task]\nprint_background_mode = "drain"\n\n[loop_control]\nmax_attempts_per_step = 5\n',
    );

    await applyPrintModeConfigDefaults(config);

    expect(resolvePrintBackgroundMode(config)).toBe('drain');
    expect(resolveAgentTaskConfig(config)?.bashTaskTimeoutS).toBe(0);
    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION)).toMatchObject({
      maxAttemptsPerStep: 5,
      maxStepsPerTurn: 0,
    });

    disposables.dispose();
  });

  it('does not override the subagent timeout env override', async () => {
    const env: Record<string, string> = { [SUBAGENT_TIMEOUT_ENV]: '3000' };
    const { config, disposables } = await createConfig(env);

    await applyPrintModeConfigDefaults(config);

    expect(resolveSubagentTimeoutMs(config)).toBe(3000);

    disposables.dispose();
  });
});

describe('subagent config section', () => {
  async function createConfig(env: Record<string, string>, toml?: string) {
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    if (toml !== undefined) {
      await storage.write('', 'config.toml', new TextEncoder().encode(toml));
    }
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;
    return { config, disposables };
  }

  function modelService(aliases: Record<string, string> = {}): IModelService {
    return {
      resolveId: (id: string) => aliases[id],
    } as unknown as IModelService;
  }

  function configError(run: () => unknown): Error2 {
    return codedError(run, ErrorCodes.CONFIG_INVALID);
  }

  function codedError(run: () => unknown, code: string): Error2 {
    try {
      run();
    } catch (error) {
      expect(isError2(error)).toBe(true);
      expect((error as Error2).code).toBe(code);
      return error as Error2;
    }
    throw new Error(`Expected ${code}`);
  }

  it('defaults to two hours and honours the env override', async () => {
    const env: Record<string, string> = {};
    const { config, disposables } = await createConfig(env);

    expect(resolveSubagentTimeoutMs(config)).toBe(DEFAULT_SUBAGENT_TIMEOUT_MS);

    env[SUBAGENT_TIMEOUT_ENV] = '3000';
    expect(resolveSubagentTimeoutMs(config)).toBe(3000);

    disposables.dispose();
  });

  it('accepts zero and surrounding whitespace while rejecting empty, negative, and non-integer env values', async () => {
    const env: Record<string, string> = {};
    const { config, disposables } = await createConfig(env);

    env[SUBAGENT_TIMEOUT_ENV] = ' 0 ';
    expect(resolveSubagentTimeoutMs(config)).toBe(0);

    for (const invalid of ['', '   ', 'abc', '-1', '1.5']) {
      env[SUBAGENT_TIMEOUT_ENV] = invalid;
      expect(resolveSubagentTimeoutMs(config)).toBe(DEFAULT_SUBAGENT_TIMEOUT_MS);
    }

    disposables.dispose();
  });

  it('formats bounded and disabled timeout values for user-facing descriptions', () => {
    expect(formatSubagentTimeoutDescription(DEFAULT_SUBAGENT_TIMEOUT_MS)).toBe('2 hours');
    expect(formatSubagentTimeoutDescription(5 * 60 * 60 * 1000)).toBe('5 hours');
    expect(formatSubagentTimeoutDescription(0)).toBe('unlimited');
  });

  it('reads timeout_ms from config.toml and lets the env var win', async () => {
    const env: Record<string, string> = {};
    const { config, disposables } = await createConfig(env, '[subagent]\ntimeout_ms = 5000\n');
    expect(resolveSubagentTimeoutMs(config)).toBe(5000);

    env[SUBAGENT_TIMEOUT_ENV] = '7000';
    expect(resolveSubagentTimeoutMs(config)).toBe(7000);

    disposables.dispose();
  });

  it('accepts a disabled timeout_ms from config.toml', async () => {
    const { config, disposables } = await createConfig(
      {},
      '[subagent]\ntimeout_ms = 0\n',
    );

    expect(resolveSubagentTimeoutMs(config)).toBe(0);

    disposables.dispose();
  });

  it('restores the env-owned timeout to the raw value on set() while the env var is set', async () => {
    const env: Record<string, string> = { [SUBAGENT_TIMEOUT_ENV]: '7000' };
    const { config, disposables } = await createConfig(env, '[subagent]\ntimeout_ms = 5000\n');

    await config.set(SUBAGENT_SECTION, { timeoutMs: 7000 });

    expect(resolveSubagentTimeoutMs(config)).toBe(7000);
    expect(config.inspect<SubagentConfig>(SUBAGENT_SECTION).userValue).toEqual({
      timeoutMs: 5000,
    });

    disposables.dispose();
  });

  it('clears the raw section when stripping removes the last persisted field', async () => {
    const env: Record<string, string> = { [SUBAGENT_TIMEOUT_ENV]: '7000' };
    const { config, disposables } = await createConfig(env);

    await config.set(SUBAGENT_SECTION, { timeoutMs: 7000 });

    expect(resolveSubagentTimeoutMs(config)).toBe(7000);
    expect(config.inspect<SubagentConfig>(SUBAGENT_SECTION).userValue).toBeUndefined();

    delete env[SUBAGENT_TIMEOUT_ENV];
    expect(config.get<SubagentConfig>(SUBAGENT_SECTION)).toEqual({
      timeoutMs: DEFAULT_SUBAGENT_TIMEOUT_MS,
      maxDirectChildren: 16,
      maxTotalSubagents: 0,
      defaultProfile: DEFAULT_SUBAGENT_PROFILE,
    });

    disposables.dispose();
  });

  it('reads subagent deny_models from config.toml', async () => {
    const { config, disposables } = await createConfig(
      {},
      '[subagent]\ndeny_models = ["provider/blocked"]\n',
    );

    expect(config.get<SubagentConfig>(SUBAGENT_SECTION)).toMatchObject({
      denyModels: ['provider/blocked'],
    });

    disposables.dispose();
  });

  it('binds the dispatched model_alias ahead of the profile pin', async () => {
    const { config, disposables } = await createConfig({});

    const binding = resolveSubagentBinding(
      config,
      { modelAlias: 'provider/exact' },
      { modelAlias: 'provider/pinned' },
    );

    expect(binding).toEqual({
      model: 'provider/exact',
      thinking: undefined,
    });
    expect(subagentModelSource(binding)).toBe('tool');

    disposables.dispose();
  });

  it('binds the profile pin when the dispatch names no model', async () => {
    const { config, disposables } = await createConfig({});

    const binding = resolveSubagentBinding(
      config,
      { thinkingEffort: 'low' },
      { modelAlias: 'provider/pinned', thinkingEffort: 'high' },
    );

    expect(binding).toEqual({
      model: 'provider/pinned',
      thinking: 'low',
    });
    expect(subagentModelSource(binding)).toBe('profile');

    disposables.dispose();
  });

  it('fails closed with MODEL_NOT_CONFIGURED when neither source names a model', async () => {
    const { config, disposables } = await createConfig({});

    const error = codedError(
      () =>
        resolveSubagentBinding(config, {}, {}, undefined, undefined, {
          profileName: 'explore',
        }),
      ErrorCodes.MODEL_NOT_CONFIGURED,
    );

    expect(error.code).toBe(ErrorCodes.MODEL_NOT_CONFIGURED);
    expect(error.message).toContain('No model is bound for agent profile "explore"');
    expect(error.message).toContain(SUBAGENT_MODEL_UNBOUND_HINT);
    expect(error.details?.['profile']).toBe('explore');

    disposables.dispose();
  });

  it('names the route in the unbound error when the dispatch targeted one', async () => {
    const { config, disposables } = await createConfig({});

    const error = codedError(
      () =>
        resolveSubagentBinding(config, {}, {}, undefined, undefined, {
          profileName: 'explore',
          routeId: 'fast-explore',
        }),
      ErrorCodes.MODEL_NOT_CONFIGURED,
    );

    expect(error.message).toContain('No model is bound for route "fast-explore"');
    expect(error.details?.['route']).toBe('fast-explore');

    disposables.dispose();
  });

  it('canonicalizes the bound alias through ModelService', async () => {
    const { config, disposables } = await createConfig({});
    const models = modelService({ fast: 'provider/fast' });

    const binding = canonicalizeSubagentBinding(
      resolveSubagentBinding(config, { modelAlias: 'fast' }, {}, models),
      models,
    );

    expect(binding).toEqual({
      model: 'provider/fast',
      thinking: undefined,
    });

    disposables.dispose();
  });

  it('rejects a dispatched model_alias denied by canonical model identity', async () => {
    const { config, disposables } = await createConfig(
      {},
      '[subagent]\ndeny_models = ["provider/blocked"]\n',
    );
    const error = configError(() =>
      resolveSubagentBinding(
        config,
        { modelAlias: 'blocked' },
        {},
        modelService({ blocked: 'provider/blocked' }),
      ),
    );

    expect(error.message).toContain('provider/blocked');
    expect(error.details?.['deniedModels']).toEqual(['provider/blocked']);
    disposables.dispose();
  });

  it('rejects a profile model_alias listed in deny_models', async () => {
    const { config, disposables } = await createConfig(
      {},
      '[subagent]\ndeny_models = ["provider/blocked"]\n',
    );
    const error = configError(() =>
      resolveSubagentBinding(config, {}, { modelAlias: 'provider/blocked' }, modelService()),
    );

    expect(error.message).toContain('provider/blocked');
    disposables.dispose();
  });
});

describe('mcp config section', () => {
  async function createConfig(env: Record<string, string>, toml?: string) {
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    if (toml !== undefined) {
      await storage.write('', 'config.toml', new TextEncoder().encode(toml));
    }
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;
    return { config, disposables };
  }

  it('is unset by default and honours the env override', async () => {
    const env: Record<string, string> = {};
    const { config, disposables } = await createConfig(env);

    expect(config.get<McpSection | undefined>(MCP_SECTION)?.startupTimeoutMs).toBeUndefined();

    expect(MCP_STARTUP_TIMEOUT_ENV).toBe('KIKI_MCP_STARTUP_TIMEOUT_MS');
    expect(MCP_TOOL_TIMEOUT_ENV).toBe('KIKI_MCP_TOOL_TIMEOUT_MS');
    env['KIMI_MCP_STARTUP_TIMEOUT_MS'] = '12000';
    env['KIMI_MCP_TOOL_TIMEOUT_MS'] = '12000';
    expect(config.get<McpSection | undefined>(MCP_SECTION)?.startupTimeoutMs).toBeUndefined();
    expect(config.get<McpSection | undefined>(MCP_SECTION)?.toolTimeoutMs).toBeUndefined();
    env[MCP_STARTUP_TIMEOUT_ENV] = 'abc';
    expect(config.get<McpSection | undefined>(MCP_SECTION)?.startupTimeoutMs).toBeUndefined();

    env[MCP_STARTUP_TIMEOUT_ENV] = '60000';
    expect(config.get<McpSection | undefined>(MCP_SECTION)?.startupTimeoutMs).toBe(60000);

    disposables.dispose();
  });

  it('accepts the Node.js timer upper boundary', () => {
    expect(
      McpSectionSchema.safeParse({
        startupTimeoutMs: 2_147_483_647,
        toolTimeoutMs: 2_147_483_647,
      }).success,
    ).toBe(true);
  });

  it('rejects config timeouts above the Node.js timer limit', () => {
    expect(
      McpSectionSchema.safeParse({
        startupTimeoutMs: 2_147_483_648,
        toolTimeoutMs: 2_147_483_648,
      }).success,
    ).toBe(false);
  });

  it('falls back to config when env timeouts exceed the Node.js timer limit', async () => {
    const env: Record<string, string> = {
      [MCP_STARTUP_TIMEOUT_ENV]: '2147483648',
      [MCP_TOOL_TIMEOUT_ENV]: '2147483648',
    };
    const { config, disposables } = await createConfig(
      env,
      '[mcp]\nstartup_timeout_ms = 5000\ntool_timeout_ms = 60000\n',
    );
    try {
      expect(config.get<McpSection | undefined>(MCP_SECTION)).toEqual({
        startupTimeoutMs: 5000,
        toolTimeoutMs: 60000,
      });
    } finally {
      disposables.dispose();
    }
  });

  it('reads startup_timeout_ms from config.toml and lets the env var win', async () => {
    const env: Record<string, string> = {};
    const { config, disposables } = await createConfig(env, '[mcp]\nstartup_timeout_ms = 5000\n');
    expect(config.get<McpSection | undefined>(MCP_SECTION)?.startupTimeoutMs).toBe(5000);

    env[MCP_STARTUP_TIMEOUT_ENV] = '7000';
    expect(config.get<McpSection | undefined>(MCP_SECTION)?.startupTimeoutMs).toBe(7000);

    disposables.dispose();
  });

  it('reads tool_timeout_ms from config.toml and lets the env var win', async () => {
    const env: Record<string, string> = {};
    const { config, disposables } = await createConfig(env, '[mcp]\ntool_timeout_ms = 60000\n');
    expect(config.get<McpSection | undefined>(MCP_SECTION)?.toolTimeoutMs).toBe(60000);

    env[MCP_TOOL_TIMEOUT_ENV] = 'abc';
    expect(config.get<McpSection | undefined>(MCP_SECTION)?.toolTimeoutMs).toBe(60000);

    env[MCP_TOOL_TIMEOUT_ENV] = '90000';
    expect(config.get<McpSection | undefined>(MCP_SECTION)?.toolTimeoutMs).toBe(90000);

    disposables.dispose();
  });

  it('restores the env-owned timeout to the raw value on set() while the env var is set', async () => {
    const env: Record<string, string> = { [MCP_STARTUP_TIMEOUT_ENV]: '7000' };
    const { config, disposables } = await createConfig(env, '[mcp]\nstartup_timeout_ms = 5000\n');

    await config.set(MCP_SECTION, { startupTimeoutMs: 7000 });

    expect(config.get<McpSection | undefined>(MCP_SECTION)?.startupTimeoutMs).toBe(7000);
    expect(config.inspect<McpSection>(MCP_SECTION).userValue).toEqual({
      startupTimeoutMs: 5000,
    });

    disposables.dispose();
  });
});

describe('get() freshness for overlay-written domains', () => {
  it('recomputes overlay values on every get()', async () => {
    const env: Record<string, string> = {};
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;

    ix.get(IConfigRegistry).registerEffectiveOverlay({
      apply(effective, getEnv) {
        if (getEnv('SMOKE_OVERLAY_FLAG') !== '1') return [];
        effective['overlayDomain'] = { flag: true };
        return ['overlayDomain'];
      },
    });

    expect(config.get('overlayDomain')).toBeUndefined();
    env['SMOKE_OVERLAY_FLAG'] = '1';
    expect(config.get('overlayDomain')).toEqual({ flag: true });
    delete env['SMOKE_OVERLAY_FLAG'];
    expect(config.get('overlayDomain')).toBeUndefined();

    disposables.dispose();
  });
});

describe('nested env bindings', () => {
  it('does not mutate the env-free base when applying nested bindings', async () => {
    const env: Record<string, string> = {};
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    await storage.write(
      '',
      'config.toml',
      new TextEncoder().encode('[nested_demo.inner]\nvalue = "file"\n'),
    );
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;

    const nestedSchema = { parse: (value: unknown) => value as { inner?: { value?: string } } };
    ix.get(IConfigRegistry).registerSection('nestedDemo', nestedSchema, {
      env: { inner: { value: 'SMOKE_NESTED_ENV' } },
    });

    env['SMOKE_NESTED_ENV'] = 'env-value';
    expect(config.get<{ inner?: { value?: string } }>('nestedDemo')).toEqual({
      inner: { value: 'env-value' },
    });

    delete env['SMOKE_NESTED_ENV'];
    expect(config.get<{ inner?: { value?: string } }>('nestedDemo')).toEqual({
      inner: { value: 'file' },
    });

    disposables.dispose();
  });
});

describe('config section collection fold (D12)', () => {
  const RUNTIME_SECTION = 'runtimeFoldDemo';
  const RUNTIME_NOTE_ENV = 'RUNTIME_FOLD_DEMO_NOTE';

  interface RuntimeFoldDemo {
    enabled: boolean;
    note?: string;
  }

  const RuntimeFoldDemoSchema: ConfigSchema<RuntimeFoldDemo> = {
    parse(value: unknown): RuntimeFoldDemo {
      const demo = value as RuntimeFoldDemo;
      if (typeof demo?.enabled !== 'boolean') {
        throw new Error('runtimeFoldDemo.enabled must be a boolean');
      }
      return demo;
    },
  };

  interface IRuntimeSectionContributor {
    readonly marker: string;
  }
  const IRuntimeSectionContributor = createDecorator<IRuntimeSectionContributor>(
    'test-runtime-section-contributor',
  );

  class RuntimeSectionContributor extends Service implements IRuntimeSectionContributor {
    readonly marker = 'runtime-section-contributor';
    constructor(contribution: ConfigSectionContribution) {
      super();
      this.provide(ConfigSectionContribution, contribution);
    }
  }

  interface IRuntimeWriteValidatorContributor {
    readonly marker: string;
  }
  const IRuntimeWriteValidatorContributor = createDecorator<IRuntimeWriteValidatorContributor>(
    'test-runtime-write-validator-contributor',
  );

  class RuntimeWriteValidatorContributor extends Service implements IRuntimeWriteValidatorContributor {
    readonly marker = 'runtime-write-validator-contributor';
    constructor(domain: string) {
      super();
      this.provide(ConfigWriteValidatorContribution, {
        domain,
        validate: (value) => {
          if ((value as RuntimeFoldDemo).note === 'rejected') throw new Error('write rejected');
        },
      });
    }
  }

  function sectionContribution<T>(
    domain: string,
    schema: ConfigSchema<T>,
    options: RegisterSectionOptions<T> = {},
  ): ConfigSectionContribution {
    return {
      domain,
      schema: schema as ConfigSchema<unknown>,
      options: options as RegisterSectionOptions<unknown>,
    };
  }

  function provideContribution(
    ix: TestInstantiationService,
    contribution: ConfigSectionContribution,
  ): ProvideHandle {
    const handle = ix.provide(
      IRuntimeSectionContributor,
      new SyncDescriptor(RuntimeSectionContributor, [contribution] as never),
    );
    ix.invokeFunction((accessor) => accessor.get(IRuntimeSectionContributor));
    return handle;
  }

  function setupFold(env: Record<string, string>) {
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    return { disposables, ix, storage };
  }

  it('activates a runtime-provided section: defaults, env bindings and validation apply', async () => {
    const env: Record<string, string> = {};
    const { disposables, ix } = setupFold(env);
    const registry = ix.get(IConfigRegistry);
    const config = ix.get(IConfigService);
    await config.ready;
    expect(registry.getSection(RUNTIME_SECTION)).toBeUndefined();

    provideContribution(
      ix,
      sectionContribution(RUNTIME_SECTION, RuntimeFoldDemoSchema, {
        defaultValue: { enabled: true },
        env: { note: RUNTIME_NOTE_ENV },
      }),
    );

    expect(registry.getSection(RUNTIME_SECTION)).toBeDefined();
    expect(config.get<RuntimeFoldDemo>(RUNTIME_SECTION)).toEqual({ enabled: true });
    env[RUNTIME_NOTE_ENV] = 'from-env';
    expect(config.get<RuntimeFoldDemo>(RUNTIME_SECTION)).toEqual({
      enabled: true,
      note: 'from-env',
    });
    delete env[RUNTIME_NOTE_ENV];
    expect(config.get<RuntimeFoldDemo>(RUNTIME_SECTION)).toEqual({ enabled: true });

    await config.set(RUNTIME_SECTION, { enabled: false }, ConfigTarget.Memory);
    expect(config.get<RuntimeFoldDemo>(RUNTIME_SECTION)).toEqual({ enabled: false });
    await expect(
      config.set(RUNTIME_SECTION, { enabled: 'nope' }, ConfigTarget.Memory),
    ).rejects.toThrow('enabled');

    disposables.dispose();
  });

  it('runs contributed semantic validators before every persisted write path', async () => {
    const { disposables, ix, storage } = setupFold({});
    const config = ix.get(IConfigService);
    await config.ready;
    provideContribution(ix, sectionContribution(RUNTIME_SECTION, RuntimeFoldDemoSchema));
    ix.provide(
      IRuntimeWriteValidatorContributor,
      new SyncDescriptor(RuntimeWriteValidatorContributor, [RUNTIME_SECTION] as never),
    );
    ix.invokeFunction((accessor) => accessor.get(IRuntimeWriteValidatorContributor));

    await config.replace(RUNTIME_SECTION, { enabled: true, note: 'accepted' });
    const before = await storage.read('', 'config.toml');
    const invalid = { enabled: true, note: 'rejected' };
    await expect(config.set(RUNTIME_SECTION, { note: 'rejected' })).rejects.toThrow('write rejected');
    await expect(config.replace(RUNTIME_SECTION, invalid)).rejects.toThrow('write rejected');
    await expect(config.replaceSections({ [RUNTIME_SECTION]: invalid })).rejects.toThrow('write rejected');
    expect(await storage.read('', 'config.toml')).toEqual(before);
    expect(config.inspect<RuntimeFoldDemo>(RUNTIME_SECTION).userValue).toEqual({
      enabled: true,
      note: 'accepted',
    });

    disposables.dispose();
  });

  it('withdraws the section when the provider dies; TOML values survive, builtins untouched', async () => {
    const env: Record<string, string> = {};
    const { disposables, ix, storage } = setupFold(env);
    const config = ix.get(IConfigService);
    await config.ready;
    const registry = ix.get(IConfigRegistry);
    const builtinSection = registry.getSection(DEFAULT_PERMISSION_MODE_SECTION);

    const handle = provideContribution(
      ix,
      sectionContribution(RUNTIME_SECTION, RuntimeFoldDemoSchema, {
        defaultValue: { enabled: true },
      }),
    );
    await config.set(RUNTIME_SECTION, { enabled: false, note: 'kept' }, ConfigTarget.User);
    expect(config.get<RuntimeFoldDemo>(RUNTIME_SECTION)).toEqual({
      enabled: false,
      note: 'kept',
    });

    handle.dispose();
    await ix.cascade.whenIdle();

    expect(registry.getSection(RUNTIME_SECTION)).toBeUndefined();
    const persisted = await storage.read('', 'config.toml');
    expect(new TextDecoder().decode(persisted)).toContain('runtime_fold_demo');
    expect(config.get<RuntimeFoldDemo>(RUNTIME_SECTION)).toEqual({
      enabled: false,
      note: 'kept',
    });
    expect(registry.getSection(DEFAULT_PERMISSION_MODE_SECTION)).toBe(builtinSection);
    expect(registry.validate(DEFAULT_PERMISSION_MODE_SECTION, 'auto')).toBe('auto');

    disposables.dispose();
  });

  it('logs — never throws — a record colliding with a builtin section, and the builtin survives', async () => {
    const env: Record<string, string> = {};
    const { disposables, ix } = setupFold(env);
    const config = ix.get(IConfigService);
    await config.ready;
    const registry = ix.get(IConfigRegistry);
    const builtinSection = registry.getSection(DEFAULT_PERMISSION_MODE_SECTION);

    const logged: unknown[] = [];
    setUnexpectedErrorHandler((err) => logged.push(err));
    try {
      const handle = provideContribution(
        ix,
        sectionContribution(DEFAULT_PERMISSION_MODE_SECTION, { parse: () => 'rogue' }),
      );
      expect(logged).toHaveLength(1);
      expect(String(logged[0])).toContain('already registered');
      expect(registry.getSection(DEFAULT_PERMISSION_MODE_SECTION)).toBe(builtinSection);
      expect(registry.validate(DEFAULT_PERMISSION_MODE_SECTION, 'auto')).toBe('auto');

      handle.dispose();
      await ix.cascade.whenIdle();

      expect(registry.getSection(DEFAULT_PERMISSION_MODE_SECTION)).toBe(builtinSection);
    } finally {
      resetUnexpectedErrorHandler();
      disposables.dispose();
    }
  });
});

function toolNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (item === null || typeof item !== 'object') return null;
      const record = item as Record<string, unknown>;
      return typeof record['name'] === 'string' ? record['name'] : null;
    })
    .filter((name): name is string => name !== null);
}

describe('ConfigService thinking effort max migration', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'kimi-v2-cfg-migrate-'));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  async function createMigratingConfig(toml: string) {
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    await storage.write('', 'config.toml', new TextEncoder().encode(toml));
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap(homeDir));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;
    return { config, disposables };
  }

  function readMarkers(): Record<string, string> {
    return JSON.parse(readFileSync(join(homeDir, 'migrations-effort.json'), 'utf-8')) as Record<
      string,
      string
    >;
  }

  it('rewrites a persisted max to high on first load and records the marker', async () => {
    const { config, disposables } = await createMigratingConfig(
      '[thinking]\nenabled = true\neffort = "max"\n',
    );

    expect(config.get<ThinkingConfig>(THINKING_SECTION)).toEqual({
      enabled: true,
      effort: 'high',
    });
    expect(readMarkers()['thinking-effort-max-to-high']).toBeDefined();

    disposables.dispose();
  });

  it('honors a hand-set max once the marker exists', async () => {
    writeFileSync(
      join(homeDir, 'migrations-effort.json'),
      JSON.stringify({ 'thinking-effort-max-to-high': new Date().toISOString() }),
    );
    const { config, disposables } = await createMigratingConfig('[thinking]\neffort = "max"\n');

    expect(config.get<ThinkingConfig>(THINKING_SECTION)).toEqual({ effort: 'max' });

    disposables.dispose();
  });

  it('records the marker even when nothing needs migrating', async () => {
    const { config, disposables } = await createMigratingConfig('[thinking]\neffort = "low"\n');

    expect(config.get<ThinkingConfig>(THINKING_SECTION)).toEqual({ effort: 'low' });
    expect(readMarkers()['thinking-effort-max-to-high']).toBeDefined();

    disposables.dispose();
  });
});

describe('ConfigService replaceSections', () => {
  const SEED_TOML = [
    'default_model = "acme/m1"',
    '',
    '[providers.acme]',
    'type = "openai"',
    'api_key = "sk-acme"',
    '',
    '[models."acme/m1"]',
    'provider = "acme"',
    'model = "m1"',
    'max_context_size = 1000',
    '',
    '[thinking]',
    'enabled = true',
    '',
  ].join('\n');

  async function createSectionsConfig(toml = SEED_TOML) {
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    await storage.write('', 'config.toml', new TextEncoder().encode(toml));
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg-replace-sections'));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;
    const store = ix.get(IAtomicTomlDocumentStore);
    return { config, disposables, store, storage };
  }

  it('applies every domain in one transition with a single disk write, clearing undefined domains', async () => {
    const { config, disposables, store } = await createSectionsConfig();
    const setSpy = vi.spyOn(store, 'set');
    const setTextSpy = vi.spyOn(store, 'setText');

    await config.replaceSections({
      [PROVIDERS_SECTION]: { acme: { type: 'openai', apiKey: 'sk-acme-2' } },
      [MODELS_SECTION]: { 'acme/m2': { provider: 'acme', model: 'm2', maxContextSize: 2000 } },
      [DEFAULT_MODEL_SECTION]: undefined,
      [THINKING_SECTION]: undefined,
    });

    expect(setSpy.mock.calls.length + setTextSpy.mock.calls.length).toBe(1);
    expect(config.get<Record<string, unknown>>(PROVIDERS_SECTION)).toEqual({
      acme: { type: 'openai', apiKey: 'sk-acme-2' },
    });
    expect(config.get<Record<string, unknown>>(MODELS_SECTION)).toEqual({
      'acme/m2': { provider: 'acme', model: 'm2', maxContextSize: 2000 },
    });
    expect(config.get(DEFAULT_MODEL_SECTION)).toBeUndefined();
    expect(config.get(THINKING_SECTION)).toEqual({});
    expect(config.inspect(DEFAULT_MODEL_SECTION).userValue).toBeUndefined();
    expect(config.inspect(THINKING_SECTION).userValue).toEqual({});

    disposables.dispose();
  });

  it('treats null as clear — the wire encoding JSON transports use for undefined', async () => {
    const { config, disposables, store } = await createSectionsConfig();
    const setSpy = vi.spyOn(store, 'set');
    const setTextSpy = vi.spyOn(store, 'setText');

    await config.replaceSections({
      [DEFAULT_MODEL_SECTION]: null,
      [PROVIDERS_SECTION]: { acme: { type: 'openai', apiKey: 'sk-acme-2' } },
    });

    expect(setSpy.mock.calls.length + setTextSpy.mock.calls.length).toBe(1);
    expect(config.get(DEFAULT_MODEL_SECTION)).toBeUndefined();
    expect(config.inspect(DEFAULT_MODEL_SECTION).userValue).toBeUndefined();
    expect(config.get<Record<string, unknown>>(PROVIDERS_SECTION)).toEqual({
      acme: { type: 'openai', apiKey: 'sk-acme-2' },
    });

    await config.replace(DEFAULT_MODEL_SECTION, 'acme/m1');
    await config.replace(DEFAULT_MODEL_SECTION, null);
    expect(config.inspect(DEFAULT_MODEL_SECTION).userValue).toBeUndefined();

    disposables.dispose();
  });

  it('fires change events only after all domains have taken effect', async () => {
    const { config, disposables } = await createSectionsConfig();
    const domains: string[] = [];
    let snapshotDuringFirstEvent:
      | { providers: unknown; models: unknown; defaultModel: unknown; thinking: unknown }
      | undefined;
    config.onDidSectionChange((e) => {
      domains.push(e.domain);
      snapshotDuringFirstEvent ??= {
        providers: config.get(PROVIDERS_SECTION),
        models: config.get(MODELS_SECTION),
        defaultModel: config.get(DEFAULT_MODEL_SECTION),
        thinking: config.get(THINKING_SECTION),
      };
    });

    await config.replaceSections({
      [PROVIDERS_SECTION]: { acme: { type: 'openai', apiKey: 'sk-acme-2' } },
      [MODELS_SECTION]: { 'acme/m2': { provider: 'acme', model: 'm2', maxContextSize: 2000 } },
      [DEFAULT_MODEL_SECTION]: undefined,
      [THINKING_SECTION]: undefined,
    });

    expect(snapshotDuringFirstEvent).toEqual({
      providers: { acme: { type: 'openai', apiKey: 'sk-acme-2' } },
      models: { 'acme/m2': { provider: 'acme', model: 'm2', maxContextSize: 2000 } },
      defaultModel: undefined,
      thinking: {},
    });
    expect([...domains].sort()).toEqual(
      [PROVIDERS_SECTION, MODELS_SECTION, DEFAULT_MODEL_SECTION, THINKING_SECTION].sort(),
    );

    disposables.dispose();
  });

  it('supports the memory target without touching the persisted user layer', async () => {
    const { config, disposables, store } = await createSectionsConfig();
    const setSpy = vi.spyOn(store, 'set');

    await config.replaceSections(
      { [THINKING_SECTION]: { enabled: false, effort: 'low' } },
      ConfigTarget.Memory,
    );

    expect(setSpy).not.toHaveBeenCalled();
    expect(config.get<ThinkingConfig>(THINKING_SECTION)).toEqual({
      enabled: false,
      effort: 'low',
    });
    expect(config.inspect<ThinkingConfig>(THINKING_SECTION).userValue).toEqual({ enabled: true });

    disposables.dispose();
  });

  it('leaves the user layer untouched when a later domain fails validation', async () => {
    const { config, disposables, store } = await createSectionsConfig();
    const setSpy = vi.spyOn(store, 'set');

    await expect(
      config.replaceSections({
        [PROVIDERS_SECTION]: { acme: { type: 'openai', apiKey: 'sk-acme-2' } },
        [THINKING_SECTION]: { enabled: 'yes' },
      }),
    ).rejects.toThrow();

    expect(setSpy).not.toHaveBeenCalled();
    expect(config.inspect<Record<string, unknown>>(PROVIDERS_SECTION).userValue).toEqual({
      acme: { type: 'openai', apiKey: 'sk-acme' },
    });
    expect(config.get<Record<string, unknown>>(PROVIDERS_SECTION)).toEqual({
      acme: { type: 'openai', apiKey: 'sk-acme' },
    });
    expect(config.inspect<ThinkingConfig>(THINKING_SECTION).userValue).toEqual({ enabled: true });

    disposables.dispose();
  });
});

describe('ConfigService persistence guards', () => {
  class SilentStorage extends InMemoryStorageService {
    override watch(): Event<void> {
      return Event.None as Event<void>;
    }
  }

  async function createGuardedConfig(toml: string, env: NodeJS.ProcessEnv = {}) {
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new SilentStorage();
    await storage.write('', 'config.toml', new TextEncoder().encode(toml));
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg-guards', env));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;
    return { config, disposables, storage };
  }

  async function overwrite(storage: InMemoryStorageService, toml: string): Promise<void> {
    await storage.write('', 'config.toml', new TextEncoder().encode(toml));
  }

  async function stored(storage: InMemoryStorageService): Promise<string> {
    const bytes = await storage.read('', 'config.toml');
    return new TextDecoder().decode(bytes);
  }

  async function expectPersistBlocked(promise: Promise<unknown>): Promise<void> {
    const error = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(isError2(error)).toBe(true);
    expect((error as Error2).code).toBe(ErrorCodes.CONFIG_PERSIST_BLOCKED);
  }

  it('refuses to persist when the initial load fails and keeps the file untouched', async () => {
    const broken = '[providers\nbroken';
    const { config, disposables, storage } = await createGuardedConfig(broken);

    expect(config.diagnostics().some((d) => d.severity === 'error')).toBe(true);
    expect(config.get(PROVIDERS_SECTION)).toEqual({});
    expect(config.get<CronConfig>(CRON_SECTION)).toEqual(DEFAULT_CRON_CONFIG);

    await expectPersistBlocked(config.set(THINKING_SECTION, { enabled: true }));
    await expectPersistBlocked(config.replace(THINKING_SECTION, { enabled: true }));
    await expectPersistBlocked(config.replaceSections({ [THINKING_SECTION]: { enabled: true } }));

    expect(await stored(storage)).toBe(broken);

    await config.set(THINKING_SECTION, { enabled: true }, ConfigTarget.Memory);
    expect(config.get<ThinkingConfig>(THINKING_SECTION)).toEqual({ enabled: true });

    disposables.dispose();
  });

  it('keeps last-known-good values when a reload hits a broken file, and recovers after the file is fixed', async () => {
    const { config, disposables, storage } = await createGuardedConfig(
      '[providers.acme]\ntype = "openai"\napi_key = "sk-acme"\n',
    );
    expect(config.get<Record<string, unknown>>(PROVIDERS_SECTION)).toEqual({
      acme: { type: 'openai', apiKey: 'sk-acme' },
    });

    await overwrite(storage, '= broken =');
    await config.reload();

    expect(config.get<Record<string, unknown>>(PROVIDERS_SECTION)).toEqual({
      acme: { type: 'openai', apiKey: 'sk-acme' },
    });
    await expectPersistBlocked(config.set(THINKING_SECTION, { enabled: true }));
    expect(await stored(storage)).toBe('= broken =');

    await overwrite(storage, '[providers.beta]\ntype = "openai"\napi_key = "sk-beta"\n');
    await config.reload();

    expect(config.get<Record<string, unknown>>(PROVIDERS_SECTION)).toEqual({
      beta: { type: 'openai', apiKey: 'sk-beta' },
    });
    await config.set(THINKING_SECTION, { enabled: true });
    expect(config.get<ThinkingConfig>(THINKING_SECTION)).toEqual({ enabled: true });

    disposables.dispose();
  });

  it('merges external edits observed at persist time instead of clobbering them', async () => {
    const { config, disposables, storage } = await createGuardedConfig(
      'default_model = "acme/m1"\n\n[providers.acme]\ntype = "openai"\napi_key = "sk-acme"\n',
    );

    await overwrite(
      storage,
      'default_model = "acme/m1"\n\n[providers.acme]\ntype = "openai"\napi_key = "sk-acme-2"\n\n[providers.beta]\ntype = "openai"\napi_key = "sk-beta"\n',
    );

    const changed: string[] = [];
    config.onDidSectionChange((e) => changed.push(e.domain));
    await config.set(THINKING_SECTION, { enabled: true });

    const doc = await stored(storage);
    expect(doc).toContain('sk-acme-2');
    expect(doc).toContain('[providers.beta]');
    expect(doc).toContain('[thinking]');
    expect(config.get<Record<string, unknown>>(PROVIDERS_SECTION)).toEqual({
      acme: { type: 'openai', apiKey: 'sk-acme-2' },
      beta: { type: 'openai', apiKey: 'sk-beta' },
    });
    expect(config.get<ThinkingConfig>(THINKING_SECTION)).toEqual({ enabled: true });
    expect(changed).toContain(PROVIDERS_SECTION);
    expect(changed).toContain(THINKING_SECTION);

    disposables.dispose();
  });

  it('honors an external delete instead of resurrecting the in-memory copy', async () => {
    const { config, disposables, storage } = await createGuardedConfig(
      '[providers.acme]\ntype = "openai"\napi_key = "sk-acme"\n',
    );

    await storage.delete('', 'config.toml');
    await config.set(THINKING_SECTION, { enabled: true });

    const doc = await stored(storage);
    expect(doc).toContain('[thinking]');
    expect(doc).not.toContain('[providers.acme]');
    expect(config.inspect(PROVIDERS_SECTION).userValue).toBeUndefined();

    disposables.dispose();
  });

  it('rebases a set() merge onto external edits of the same section', async () => {
    const { config, disposables, storage } = await createGuardedConfig(
      '[providers.acme]\ntype = "openai"\napi_key = "sk-acme"\n',
    );

    await overwrite(
      storage,
      '[providers.acme]\ntype = "openai"\napi_key = "sk-acme"\n\n[providers.beta]\ntype = "openai"\napi_key = "sk-beta"\n',
    );
    await config.set(PROVIDERS_SECTION, { gamma: { type: 'openai', apiKey: 'sk-gamma' } });

    const doc = await stored(storage);
    expect(doc).toContain('[providers.beta]');
    expect(doc).toContain('[providers.gamma]');
    expect(config.get<Record<string, unknown>>(PROVIDERS_SECTION)).toEqual({
      acme: { type: 'openai', apiKey: 'sk-acme' },
      beta: { type: 'openai', apiKey: 'sk-beta' },
      gamma: { type: 'openai', apiKey: 'sk-gamma' },
    });

    disposables.dispose();
  });

  it('restores env-masked values from the freshly re-read file instead of the stale snapshot', async () => {
    const { config, disposables, storage } = await createGuardedConfig(
      'default_model = "acme/m1"\n\n[providers.acme]\ntype = "openai"\napi_key = "sk-acme"\n\n[models."acme/m1"]\nprovider = "acme"\nmodel = "m1"\n',
      { KIMI_MODEL_NAME: 'env-model' },
    );
    expect(config.get(DEFAULT_MODEL_SECTION)).toBe('__kimi_env_model__');

    await overwrite(
      storage,
      'default_model = "acme/m2"\n\n[providers.acme]\ntype = "openai"\napi_key = "sk-acme"\n\n[models."acme/m2"]\nprovider = "acme"\nmodel = "m2"\n',
    );
    await config.replace(DEFAULT_MODEL_SECTION, config.get(DEFAULT_MODEL_SECTION));

    const doc = await stored(storage);
    expect(doc).toContain('default_model = "acme/m2"');
    expect(doc).not.toContain('default_model = "acme/m1"');

    disposables.dispose();
  });

  it('keeps the in-memory snapshots untouched when a write fails validation', async () => {
    const { config, disposables, storage } = await createGuardedConfig(
      '[thinking]\nenabled = true\n',
    );

    await overwrite(storage, '[thinking]\nenabled = false\n');
    await expect(config.set(THINKING_SECTION, { enabled: 'yes' })).rejects.toThrow();

    expect(config.inspect(THINKING_SECTION).userValue).toEqual({ enabled: true });
    expect(await stored(storage)).toBe('[thinking]\nenabled = false\n');

    disposables.dispose();
  });
});
