import { z } from 'zod';

import { Event2, registerEvent2Class } from '#/app/event/event2';

const towerModeSchema = z.object({});

class TowerModeEnter extends Event2<z.infer<typeof towerModeSchema>> {
  static override readonly type = 'tower_mode.enter';
  static override readonly durable = true;
  static override readonly schema = towerModeSchema;
}

class TowerModeExit extends Event2<z.infer<typeof towerModeSchema>> {
  static override readonly type = 'tower_mode.exit';
  static override readonly durable = true;
  static override readonly schema = towerModeSchema;
}

registerEvent2Class(TowerModeEnter);
registerEvent2Class(TowerModeExit);
