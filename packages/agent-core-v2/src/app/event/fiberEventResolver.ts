import { setFiberEventResolver } from '#/_base/di/fiber';
import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { isPromiseLike } from '#/_base/lifecycle/disposer';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';

import type { Event2 } from './event2';
import { IEventBus } from './eventBus';

setFiberEventResolver((host, event, handler) => {
  const busRef = host.liveRef(IEventBus);
  let subscription: IDisposable | undefined;
  const attach = (): void => {
    if (subscription !== undefined) return;
    const bus = busRef.current;
    if (bus === undefined) return;
    subscription = bus.subscribe(event, handler as (e: Event2<any>) => void);
  };
  attach();
  const onChange = busRef.onDidChange(attach);
  return toDisposable(() => {
    onChange.dispose();
    const subscriptionResult = subscription?.dispose();
    if (isPromiseLike(subscriptionResult)) subscriptionResult.catch(onUnexpectedError);
  });
});
