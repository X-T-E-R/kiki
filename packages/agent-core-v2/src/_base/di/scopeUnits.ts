import { onUnexpectedError } from '../errors/unexpectedError';
import type { IDisposable } from './lifecycle';
import { Ledger, type LedgerEntry } from '../lifecycle/ledger';
import type { StoredRecord } from './collection';
import {
  FiberRuntime,
  isClassRecipe,
  ScopeUnits,
  type EffectBody,
  type ServiceRecipe,
} from './fiber';
import type { InstantiationService } from './instantiationService';
import type { ScopeKind } from './scope';

export function watchScopeUnits(container: InstantiationService, kind: ScopeKind): void {
  if (container.cascadeDisposed) {
    return;
  }
  const token = ScopeUnits(kind);
  const host = container.fiberHost;
  const view = host.collectionView(token);
  const foldLedger = new Ledger(`scope-units:${kind}`);
  container.anchorKernelEntry((reason) => foldLedger.teardown(reason), `scope-units:${kind}`);

  const materialized = new Map<number, () => void>();

  const materialize = (record: StoredRecord): void => {
    const recipe = record.value as ServiceRecipe;
    const name = record.providerName;
    const unitLedger = new Ledger(`scope-units:${kind}:${name}`);
    try {
      if (isClassRecipe(recipe)) {
        const instance = host.constructService(recipe, undefined) as Partial<IDisposable>;
        unitLedger.register(() => {
          instance.dispose?.();
        }, `unit:${name}`);
      } else {
        const facade = new FiberRuntime(
          host,
          unitLedger,
          name,
          undefined,
          undefined,
          new Set(recipe.inject ?? []),
          undefined,
        );
        const out =
          typeof recipe === 'function'
            ? recipe(facade, undefined)
            : recipe.apply(facade, undefined);
        unitLedger.effect((() => out) as EffectBody, `effect:${name}`);
      }
    } catch (error) {
      void unitLedger.teardown('unload');
      onUnexpectedError(error);
      return;
    }

    let retracted = false;
    let providerEntry: LedgerEntry | undefined;
    let foldEntry: LedgerEntry | undefined;
    const retract = (): void => {
      if (retracted) {
        return;
      }
      retracted = true;
      if (record.providerBook.isActive) providerEntry?.release();
      if (foldLedger.isActive) foldEntry?.release();
      providerEntry = undefined;
      foldEntry = undefined;
      materialized.delete(record.id);
      void unitLedger.teardown('unload');
    };
    if (!record.providerBook.isActive || !foldLedger.isActive) {
      retract();
      return;
    }
    providerEntry = record.providerBook.register(retract, `scope-units:${kind}`);
    foldEntry = foldLedger.register(retract, `record:${name}`);
    materialized.set(record.id, retract);
  };

  const reconcile = (): void => {
    if (!foldLedger.isActive) {
      return;
    }
    const records = container.collectionStore.storedRecordsFor(token, container);
    const seen = new Set<number>();
    for (const record of records) {
      seen.add(record.id);
      if (!materialized.has(record.id)) {
        materialize(record);
      }
    }
    for (const [id, retract] of Array.from(materialized)) {
      if (!seen.has(id)) {
        retract();
      }
    }
  };

  const subscription = view.onDidChange(() => {
    reconcile();
  });
  foldLedger.register(() => {
    subscription.dispose();
  }, 'view-subscription');
  reconcile();
}
