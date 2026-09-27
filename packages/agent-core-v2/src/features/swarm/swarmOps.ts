/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { contextMemoryKey, popSwarmModeReminder } from '#/agent/contextMemory/contextOps';
import { Event2, registerEvent2Class } from '#/app/event/event2';

const swarmModeEnterSchema = z.object({ trigger: z.enum(['manual', 'task', 'tool']) });

export class SwarmModeEnter extends Event2<z.infer<typeof swarmModeEnterSchema>> {
  static override readonly type = 'swarm_mode.enter';
  static override readonly durable = true;
  static override readonly schema = swarmModeEnterSchema;
}
export interface SwarmModeEnter extends z.infer<typeof swarmModeEnterSchema> {}
registerEvent2Class(SwarmModeEnter);

const swarmModeExitSchema = z.object({});

export class SwarmModeExit extends Event2<z.infer<typeof swarmModeExitSchema>> {
  static override readonly type = 'swarm_mode.exit';
  static override readonly durable = true;
  static override readonly schema = swarmModeExitSchema;
}
export interface SwarmModeExit extends z.infer<typeof swarmModeExitSchema> {}
registerEvent2Class(SwarmModeExit);

contextMemoryKey.on(SwarmModeExit, (state) => popSwarmModeReminder(state));
