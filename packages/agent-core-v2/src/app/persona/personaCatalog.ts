import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';

import type { PersonaSnapshot } from '@kiki/agent-profiles/personaFile';

import type { PersonaListOptions, PersonaSummary } from './personaStore';

export interface IPersonaCatalog {
  readonly _serviceBrand: undefined;
  readonly onDidChange: Event<void>;
  list(options?: PersonaListOptions): Promise<readonly PersonaSummary[]>;
  get(id: string): Promise<PersonaSnapshot | undefined>;
}

export const IPersonaCatalog: ServiceIdentifier<IPersonaCatalog> = createDecorator<IPersonaCatalog>('personaCatalog');
