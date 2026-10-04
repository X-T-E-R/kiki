import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import {
  ISessionDeliveryService,
  type SessionDeliveryMode,
} from './delivery';

const DELIVERY_KEY = 'delivery.json';
const DEFAULT_MODE: SessionDeliveryMode = 'reply';

interface DeliveryDocument {
  readonly mode: SessionDeliveryMode;
}

export class SessionDeliveryService extends Service implements ISessionDeliveryService {
  declare readonly _serviceBrand: undefined;

  private readonly changed = this._register(new Emitter<SessionDeliveryMode>());
  private readonly effectiveChanged = this._register(new Emitter<SessionDeliveryMode>());
  readonly onDidChange: Event<SessionDeliveryMode> = this.changed.event;
  readonly onDidChangeEffective: Event<SessionDeliveryMode> = this.effectiveChanged.event;
  readonly ready: Promise<void>;
  private current: SessionDeliveryMode = DEFAULT_MODE;
  private activeMode?: SessionDeliveryMode;

  constructor(
    @ISessionContext private readonly context: ISessionContext,
    @IAtomicDocumentStore private readonly documents: IAtomicDocumentStore,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
  ) {
    super();
    this.ready = this.load();
  }

  mode(): SessionDeliveryMode {
    return this.current;
  }

  effectiveMode(): SessionDeliveryMode {
    return this.activeMode ?? this.current;
  }

  beginTurn(): void {
    this.activeMode = this.current;
  }

  endTurn(): void {
    const previous = this.activeMode;
    this.activeMode = undefined;
    if (previous !== undefined && previous !== this.current) this.effectiveChanged.fire(this.current);
  }

  async set(mode: SessionDeliveryMode): Promise<void> {
    await this.ready;
    if (mode !== 'reply' && mode !== 'message') throw new TypeError(`Invalid session delivery mode: ${String(mode)}`);
    if (mode === this.current) return;
    const previous = this.current;
    try {
      await this.documents.set(this.context.metaScope, DELIVERY_KEY, { mode });
      await this.metadata.update({ delivery: mode }, { touchUpdatedAt: false });
    } catch (error) {
      await this.documents.set(this.context.metaScope, DELIVERY_KEY, { mode: previous }).catch(() => undefined);
      throw error;
    }
    this.current = mode;
    this.changed.fire(mode);
    if (this.activeMode === undefined) this.effectiveChanged.fire(mode);
  }

  private async load(): Promise<void> {
    await this.metadata.ready;
    const stored = await this.documents.get<DeliveryDocument>(this.context.metaScope, DELIVERY_KEY);
    const metadata = await this.metadata.read();
    const customMode = metadata.custom?.['delivery'];
    const mode = stored?.mode ?? metadata.delivery ?? (customMode === 'reply' || customMode === 'message' ? customMode : undefined) ?? DEFAULT_MODE;
    this.current = mode === 'message' ? 'message' : 'reply';
    if (this.current !== DEFAULT_MODE) this.effectiveChanged.fire(this.current);
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionDeliveryService,
  SessionDeliveryService,
  ScopeActivation.OnScopeCreated,
  'sessionDelivery',
);
