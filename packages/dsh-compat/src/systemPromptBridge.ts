import { scope, type Context, type CordisScopeKey } from '@kiki/cordis-runtime';
import { SystemPrompt, type AssembleContext } from './vendor/system-prompt/src/index';

const { createScope, scopeOf } = scope;

import type { DshAgentIdentityRegistry } from './initiatorAls';
import type { DshLiveAgentFacade, DshSystemPromptShim } from './index';

export interface DshPromptAssembleOptions {
  readonly scopeKey?: CordisScopeKey;
  readonly agent?: DshLiveAgentFacade;
  readonly signal?: AbortSignal;
}

export interface RenderedDshPromptResult {
  readonly sections: readonly { readonly id: string; readonly text: string }[];
  readonly contexts: readonly { readonly id: string; readonly text: string }[];
  readonly promptText: string;
}

function interpolateTemplate(
  rawText: string,
  variables: Readonly<Record<string, string | undefined>>,
  interpolate: boolean | undefined,
): string {
  if (interpolate === false) return rawText;
  return rawText.replaceAll(/\{\{([a-z][a-z0-9_]*)\}\}/g, (_match, varName: string) => {
    const resolved = variables[varName];
    if (resolved === undefined) {
      throw new Error(`unresolved DSH prompt variable "{{${varName}}}"`);
    }
    return resolved;
  });
}

/**
 * Bridge wrapping the real upstream `@deepseek-ai/dsh-system-prompt` service
 * (`ctx.systemPrompt`) while also exposing the T0 `DshSystemPromptShim` surface
 * and step-head / static section assembly helpers for Kiki slot E5.
 */
export class DshSystemPromptBridge implements DshSystemPromptShim {
  readonly upstream: SystemPrompt;
  private readonly scopedContexts = new Map<object, ReturnType<typeof createScope>>();
  private contextOrderSeq = 1000;

  constructor(
    private readonly rootCtx: Context,
    private readonly initiators: DshAgentIdentityRegistry,
  ) {
    const existing = rootCtx.get('systemPrompt');
    this.upstream = existing ?? new SystemPrompt(rootCtx, { includeHarnessIdentity: false });
  }

  private contextForScope(scopeKey?: CordisScopeKey): Context {
    if (scopeKey === undefined) return this.rootCtx;
    if (scopeOf(this.rootCtx) === scopeKey) return this.rootCtx;
    let cached = this.scopedContexts.get(scopeKey);
    if (cached === undefined) {
      cached = createScope(this.rootCtx, scopeKey);
      this.scopedContexts.set(scopeKey, cached);
    }
    return cached.ctx;
  }

  section(spec: {
    readonly id: string;
    readonly order?: number;
    readonly scope?: CordisScopeKey;
    readonly suppressRuntimeContext?: boolean;
    readonly render: (vars: Readonly<Record<string, string>>) => string | undefined;
  }): () => void {
    const targetCtx = this.contextForScope(spec.scope);
    const disposers: Array<() => void> = [];
    if (spec.suppressRuntimeContext === true) {
      disposers.push(targetCtx.systemPrompt.suppressRuntimeContext());
    }
    disposers.push(
      targetCtx.systemPrompt.section({
        name: spec.id,
        order: spec.order ?? 0,
        interpolate: false,
        text: (assembleCtx) => {
          const vars = this.collectVariables(spec.scope ?? assembleCtx.scope);
          return spec.render(vars) ?? '';
        },
      }),
    );
    return () => {
      for (const dispose of disposers.toReversed()) dispose();
    };
  }

  context(spec: {
    readonly id: string;
    readonly scope?: CordisScopeKey;
    readonly suppressRuntimeContext?: boolean;
    readonly collect: (agent: DshLiveAgentFacade) => string | undefined | Promise<string | undefined>;
  }): () => void {
    const targetCtx = this.contextForScope(spec.scope);
    const disposers: Array<() => void> = [];
    if (spec.suppressRuntimeContext === true) {
      disposers.push(targetCtx.systemPrompt.suppressRuntimeContext());
    }
    const order = this.contextOrderSeq++;
    const syncDispose = targetCtx.systemPrompt.context({
      name: spec.id,
      order,
      interpolate: false,
      text: (assembleCtx) => {
        const agent = (assembleCtx as AssembleContext & { agent?: DshLiveAgentFacade }).agent
          ?? this.initiators.currentInitiator();
        if (agent === undefined) return '';
        const collected = spec.collect(agent);
        if (typeof collected === 'string' || collected === undefined) {
          return collected ?? '';
        }
        return '';
      },
    });
    const asyncListenerDispose = targetCtx.on(
      'system-prompt/assemble' as any,
      async (assembly: any, assembleCtx: AssembleContext & { agent?: DshLiveAgentFacade }, next: () => Promise<any>) => {
        const current = await next();
        const agent = assembleCtx.agent ?? this.initiators.currentInitiator();
        if (agent === undefined) return current;
        const resolved = await spec.collect(agent);
        const text = resolved ?? '';
        const existingIdx = current.contexts.findIndex((item: { name: string }) => item.name === spec.id);
        if (text === '') {
          if (existingIdx >= 0) current.contexts.splice(existingIdx, 1);
          return current;
        }
        if (existingIdx >= 0) {
          current.contexts[existingIdx] = { name: spec.id, text, interpolate: false };
        } else {
          current.contexts.push({ name: spec.id, text, interpolate: false });
        }
        return current;
      },
    );
    disposers.push(syncDispose, () => {
      asyncListenerDispose();
    });
    return () => {
      for (const dispose of disposers.toReversed()) dispose();
    };
  }

  variable(name: string, resolver: (agent: DshLiveAgentFacade) => string | undefined): () => void {
    return this.upstream.variable(name, (assembleCtx) => {
      const agent = (assembleCtx as AssembleContext & { agent?: DshLiveAgentFacade }).agent
        ?? this.initiators.currentInitiator();
      if (agent === undefined) return undefined;
      return resolver(agent);
    });
  }

  private collectVariables(scopeKey?: CordisScopeKey): Readonly<Record<string, string>> {
    const out: Record<string, string> = {};
    const layers = (this.upstream as unknown as {
      layers: {
        global: { variables: { entries(): Iterable<[string, (ctx: AssembleContext) => string | undefined]> } };
        chainLayers(key?: object): Array<{ variables: { entries(): Iterable<[string, (ctx: AssembleContext) => string | undefined]> } }>;
      };
    }).layers;
    const assembleCtx: AssembleContext & { agent?: DshLiveAgentFacade } = {
      scope: scopeKey,
      agent: this.initiators.currentInitiator(),
    };
    for (const [key, provider] of layers.global.variables.entries()) {
      const val = provider(assembleCtx);
      if (val !== undefined) out[key] = val;
    }
    for (const layer of layers.chainLayers(scopeKey)) {
      for (const [key, provider] of layer.variables.entries()) {
        const val = provider(assembleCtx);
        if (val !== undefined) out[key] = val;
      }
    }
    return out;
  }

  async render(options: DshPromptAssembleOptions = {}): Promise<RenderedDshPromptResult> {
    const scope = options.scopeKey ?? options.agent?.scopeKey;
    const assembleCtx: AssembleContext & { agent?: DshLiveAgentFacade } = {
      scope,
      signal: options.signal,
      ...(options.agent === undefined ? {} : { agent: options.agent }),
    };
    const run = () => this.upstream.assemble(assembleCtx);
    const assembled = options.agent !== undefined && this.initiators.currentInitiator() !== options.agent
      ? await this.initiators.withInitiator(options.agent, run)
      : await run();
    const sections = assembled.sections
      .map(sec => ({
        id: sec.name,
        text: interpolateTemplate(sec.text, assembled.variables, sec.interpolate),
      }))
      .filter(sec => sec.text.length > 0);
    const contexts = assembled.contexts
      .map(ctxItem => ({
        id: ctxItem.name,
        text: interpolateTemplate(ctxItem.text, assembled.variables, ctxItem.interpolate),
      }))
      .filter(ctxItem => ctxItem.text.length > 0);
    return {
      sections,
      contexts,
      promptText: sections.map(sec => sec.text).join('\n\n'),
    };
  }

  async dispose(): Promise<void> {
    for (const scoped of this.scopedContexts.values()) await scoped.dispose();
    this.scopedContexts.clear();
  }
}
