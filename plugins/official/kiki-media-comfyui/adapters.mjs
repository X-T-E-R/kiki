import { runtime, check, options, fields, guarded, pending, failed } from './runtime.mjs';
import { randomUUID } from 'node:crypto';

function collect(value, kind, outputs = []) {
  if (Array.isArray(value)) {
    for (const child of value) collect(child, kind, outputs);
    return outputs;
  }
  if (!value || typeof value !== 'object') return outputs;
  if (value.filename) {
    const format = String(value.filename).split('.').at(-1).toLowerCase();
    const resolved =
      kind ??
      (['mp4', 'webm', 'mov', 'gif'].includes(format)
        ? 'video'
        : ['wav', 'mp3', 'flac', 'opus'].includes(format)
        ? 'audio'
        : ['png', 'jpg', 'jpeg', 'webp'].includes(format)
        ? 'image'
        : 'file');
    outputs.push({ ...value, kind: resolved });
    return outputs;
  }
  for (const [key, child] of Object.entries(value))
    collect(child, key === 'videos' ? 'video' : ['audio', 'audios'].includes(key) ? 'audio' : undefined, outputs);
  return outputs;
}
export function createAdapters(fetchImpl) {
  const workflow = {
    describe: async () => ({
      models: [
        { id: 'workflow', kind: 'image' },
        { id: 'workflow', kind: 'video' },
      ],
      constraints: [
        'Connect your running ComfyUI endpoint; Kiki does not install engines, models or GPU dependencies.',
        'Supply API-format workflow and explicit prompt/input node bindings. Every reference must have exactly one binding; roles are checked, never guessed.',
        'Native workflow may output multiple originals; no global interrupt is used to cancel a specific job.',
        'No TTS semantics are claimed for incidental audio outputs.',
      ],
      optionsSchema: {
        type: 'object',
        required: ['workflow', 'prompt_binding'],
        properties: {
          workflow: { type: 'object' },
          prompt_binding: { type: 'object', required: ['node', 'input'] },
          input_bindings: { type: 'array', items: { type: 'object', required: ['node', 'input', 'role'] } },
        },
        additionalProperties: false,
      },
    }),
    submit: (input, ctx) =>
      guarded(async () => {
        const r = input.request;
        check(['image', 'video'].includes(r.kind), 'Workflow supports image/video, not TTS');
        check(!input.model || input.model === 'workflow', 'ComfyUI model is workflow');
        const o = options(r, ['workflow', 'prompt_binding', 'input_bindings']);
        fields(
          r,
          r.kind === 'image'
            ? ['mask', 'size', 'aspect_ratio', 'format']
            : ['duration_seconds', 'aspect_ratio', 'resolution']
        );
        check(r.count === undefined || r.count === 1, 'Workflow count is not silently implemented by repeated /prompt');
        check(
          o.workflow && typeof o.workflow === 'object' && !Array.isArray(o.workflow),
          'Provide API-format workflow'
        );
        check(o.prompt_binding, 'Provide prompt_binding');
        const graph = structuredClone(o.workflow);
        const set = (binding, value) => {
          check(
            binding &&
              typeof binding.node === 'string' &&
              typeof binding.input === 'string' &&
              graph[binding.node]?.inputs &&
              Object.hasOwn(graph[binding.node].inputs, binding.input),
            'Binding must target an existing workflow node input'
          );
          graph[binding.node].inputs[binding.input] = value;
        };
        set(o.prompt_binding, r.prompt);
        const refs =
          r.kind === 'image' ? (r.images ?? []).map((ref) => ({ ref, role: 'reference_image' })) : r.inputs ?? [];
        const bindings = o.input_bindings ?? [];
        check(
          Array.isArray(bindings) && bindings.length === refs.length,
          'Every input needs exactly one workflow binding'
        );
        const rt = await runtime(ctx, fetchImpl);
        for (const [index, item] of refs.entries()) {
          check(bindings[index].role === item.role, 'Input binding role must match request role');
          set(bindings[index], 'pending');
          const file = await rt.bytes(item.ref);
          const form = new FormData();
          form.set('image', new Blob([file.data], { type: file.mime }), file.name);
          form.set('overwrite', 'false');
          const uploaded = await rt.json(rt.endpoint('/upload/image'), form);
          check(uploaded.name, 'ComfyUI upload returned no filename');
          set(bindings[index], `${uploaded.subfolder ? `${uploaded.subfolder}/` : ''}${uploaded.name}`);
        }
        const result = await rt.json(rt.endpoint('/prompt'), { prompt: graph, client_id: randomUUID() });
        if (!result.prompt_id)
          return failed({ code: 'missing_handle', message: 'ComfyUI returned no prompt_id', submission: 'unknown' });
        return pending({ id: result.prompt_id, emptyOutputPolls: 0 });
      }, 'unknown'),
    poll: (handle, ctx) =>
      guarded(async () => {
        const rt = await runtime(ctx, fetchImpl);
        let response;
        try {
          response = await rt.json(rt.endpoint(`/history/${encodeURIComponent(handle.data.id)}`));
        } catch (error) {
          if (/^http_(?:429|5\d\d)$/.test(error.code) || error.code === 'transport_error') return pending(handle.data);
          throw error;
        }
        const history = response[handle.data.id];
        if (!history) return pending(handle.data);
        const status = history.status?.status_str ?? history.status?.status ?? '';
        if (['error', 'failed'].includes(status))
          return failed({
            code: 'workflow_failed',
            message: JSON.stringify(history.status?.messages ?? status).slice(0, 500),
          });
        const outputs = collect(history.outputs);
        if (outputs.length === 0) {
          const emptyOutputPolls = status === 'success' ? (handle.data.emptyOutputPolls ?? 0) + 1 : 0;
          return emptyOutputPolls >= 10
            ? failed({
                code: 'missing_output',
                message: 'Workflow completed but output nodes produced no downloadable files',
              })
            : pending({ ...handle.data, emptyOutputPolls });
        }
        if (!history.status?.completed && status !== 'success' && status) return pending(handle.data);
        const artifacts = [];
        const errors = [];
        const seen = new Set();
        for (const [index, item] of outputs.entries()) {
          const identity = JSON.stringify([item.filename, item.subfolder, item.type]);
          if (seen.has(identity)) continue;
          seen.add(identity);
          try {
            const query = new URLSearchParams({
              filename: item.filename,
              subfolder: item.subfolder ?? '',
              type: item.type ?? 'output',
            });
            const name = `output-${index + 1}.${
              String(item.filename)
                .split('.')
                .at(-1)
                .replaceAll(/[^a-zA-Z0-9]/g, '') || 'bin'
            }`;
            artifacts.push(await rt.download(rt.endpoint(`/view?${query}`), name, item.kind));
          } catch (error) {
            errors.push({ item: item.filename, code: error.code ?? 'download_failed', message: error.message });
          }
        }
        if (errors.length > 0)
          return {
            ...pending(handle.data, 'download', artifacts),
            warnings: errors.map((e) => `${e.item}: ${e.message}`),
          };
        return { state: 'complete', artifacts };
      }, 'accepted'),
  };
  return { workflow };
}
export const adapters = createAdapters();
