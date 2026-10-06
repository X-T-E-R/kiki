import { onUnexpectedError } from '../errors/unexpectedError';
import type { IDisposable } from './lifecycle';
import { Ledger, type LedgerEntry } from '../lifecycle/ledger';
import { isPromiseLike } from '../lifecycle/disposer';
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

  const materialized = new Map<number, () => void | Promise<void>>();

  const materialize = (record: StoredRecord): void => {
    const recipe = record.value as ServiceRecipe;
    const name = record.providerName;
    const unitLedger = new Ledger(`scope-units:${kind}:${name}`);
    try {
      if (isClassRecipe(recipe)) {
        const instance = host.constructService(recipe, undefined) as Partial<IDisposable>;
        unitLedger.register(() => instance.dispose?.(), `unit:${name}`);
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
      const teardown = unitLedger.teardown('unload');
      if (isPromiseLike(teardown)) teardown.catch(onUnexpectedError);
      onUnexpectedError(error);
      return;
    }

    let retracted = false;
    let retractResult: void | Promise<void> = undefined;
    let providerEntry: LedgerEntry | undefined;
    let foldEntry: LedgerEntry | undefined;
    const detach = (): void => {
      if (record.providerBook.isActive) providerEntry?.release();
      if (foldLedger.isActive) foldEntry?.release();
      providerEntry = undefined;
      foldEntry = undefined;
      materialized.delete(record.id);
    };
    const retract = (): void | Promise<void> => {
      if (retracted) return retractResult;
      retracted = true;
      retractResult = unitLedger.teardown('unload');
      if (isPromiseLike(retractResult)) {
        retractResult = retractResult.then(detach, (error) => { detach(); throw error; });
      } else {
        detach();
      }
      return retractResult;
    };
    if (!record.providerBook.isActive || !foldLedger.isActive) {
      const result = retract();
      if (isPromiseLike(result)) result.catch(onUnexpectedError);
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
        const result = retract();
        if (isPromiseLike(result)) result.catch(onUnexpectedError);
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
