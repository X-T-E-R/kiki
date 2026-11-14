import { createDecorator } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';

import type {
  StrictPropertyCheck,
  TelemetryEventName,
  TelemetryEventPayload,
} from './events';

export type TelemetryPrimitive = string | number | boolean | null | undefined;

export type TelemetryProperties = Readonly<Record<string, TelemetryPrimitive>>;

export type TelemetryContextPatch = TelemetryProperties;

export interface ITelemetryAppender {
  track(event: string, properties?: TelemetryProperties): void;
  withContext?(patch: TelemetryContextPatch): ITelemetryAppender;
  setContext?(patch: TelemetryContextPatch): void;
  flush?(): Promise<void> | void;
  shutdown?(): Promise<void> | void;
}

export interface TelemetryServiceOptions {
  readonly appender?: ITelemetryAppender;
  readonly appenders?: readonly ITelemetryAppender[];
  readonly context?: TelemetryProperties;
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly turnId?: string;
}

export interface ITelemetryService {
  readonly _serviceBrand: undefined;

  track(event: string, properties?: TelemetryProperties): void;
  track2<K extends TelemetryEventName, E extends TelemetryEventPayload<K> = never>(
    event: K,
    properties?: StrictPropertyCheck<TelemetryEventPayload<K>, E>,
  ): void;
  withContext(patch: TelemetryContextPatch): ITelemetryService;
  setContext(patch: TelemetryContextPatch): void;
  addAppender(appender: ITelemetryAppender): IDisposable;
  removeAppender(appender: ITelemetryAppender): void;
  setAppender(appender: ITelemetryAppender): void;
  setEnabled(enabled: boolean): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

export const nullTelemetryAppender: ITelemetryAppender = {
  track: () => {},
  withContext: () => nullTelemetryAppender,
  setContext: () => {},
  flush: () => {},
  shutdown: () => {},
};

export const noopTelemetryService: ITelemetryService = {
  _serviceBrand: undefined,
  track: () => {},
  track2: () => {},
  withContext: () => noopTelemetryService,
  setContext: () => {},
  addAppender: () => ({ dispose: () => {} }),
  removeAppender: () => {},
  setAppender: () => {},
  setEnabled: () => {},
  flush: async () => {},
  shutdown: async () => {},
};

export function privateSessionTelemetry(service: ITelemetryService, isPrivate: () => boolean): ITelemetryService {
  return {
    _serviceBrand: undefined,
    track: (event, properties) => { if (!isPrivate()) service.track(event, properties); },
    track2: (event, properties) => { if (!isPrivate()) service.track2(event, properties); },
    withContext: (patch) => privateSessionTelemetry(service.withContext(patch), isPrivate),
    setContext: (patch) => service.setContext(patch),
    addAppender: (appender) => service.addAppender(appender),
    removeAppender: (appender) => service.removeAppender(appender),
    setAppender: (appender) => service.setAppender(appender),
    setEnabled: (enabled) => service.setEnabled(enabled),
    flush: () => service.flush(),
    shutdown: () => service.shutdown(),
  };
}

export const ITelemetryService = createDecorator<ITelemetryService>(
  'agentTelemetryService',
);
