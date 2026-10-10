import type { ModelCognitionBodies } from '@kiki/protocol';
import { cognitionPathRefs, isCognitionInline, type CognitionSlot } from '#/agent/cognition/cognitionFiles';
import { selectCognitionConfig } from '#/agent/cognition/cognitionConfig';
import type { CognitionConfig, CognitionContent } from '#/kosong/model/model';
import type { IModelPromptReader } from './modelPromptReader';

type Slots = ModelCognitionBodies['branches']['common']['slots'];

export async function modelPromptBodies(cognition: CognitionConfig | undefined, revision: string, reader: IModelPromptReader | undefined): Promise<ModelCognitionBodies> {
  const cache = new Map<string, Promise<Array<{ path: string; text: string }>>>();
  async function slotBody(slot: CognitionSlot, value: CognitionContent[CognitionSlot]): Promise<Slots[CognitionSlot]> {
    const channel = `cognition_${slot}` as const;
    if (isCognitionInline(value)) return { channel, source: 'inline', text: value.text, writable: true, source_read_only: false };
    const refs = cognitionPathRefs(value);
    if (refs.length === 0) return { channel, source: 'unset', writable: true, source_read_only: false };
    try {
      if (reader === undefined) throw new Error('Model prompt file reader is unavailable');
      const key = JSON.stringify([slot, refs]);
      let pending = cache.get(key);
      if (pending === undefined) { pending = reader.read(slot, refs); cache.set(key, pending); }
      const files = await pending;
      const pieces = files.map((file) => file.text.trim()).filter((text) => text.length > 0);
      return { channel, source: 'files', files, text: pieces.join('\n\n'), writable: true, source_read_only: true };
    } catch (error) {
      return { channel, source: 'files', writable: false, source_read_only: true, error: error instanceof Error ? error.message : String(error) };
    }
  }
  async function branch(scope: 'common' | 'main' | 'independent'): Promise<ModelCognitionBodies['branches']['common']> {
    const declaration = scope === 'common' ? undefined : cognition?.[scope];
    const selection = declaration === 'off' ? 'off' : typeof declaration === 'object' ? 'custom' : 'common';
    const selected = selectCognitionConfig(cognition, scope === 'common' ? 'sub' : scope);
    return {
      selection,
      source_scope: selection === 'common' ? 'common' : scope,
      slots: { overlay: await slotBody('overlay', selected?.overlay), steering: await slotBody('steering', selected?.steering), anchor: await slotBody('anchor', selected?.anchor) },
    };
  }
  return { revision, branches: { common: await branch('common'), main: await branch('main'), independent: await branch('independent') } };
}
