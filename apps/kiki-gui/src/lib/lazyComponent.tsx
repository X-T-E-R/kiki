import { useEffect, useState, type ComponentType, type ReactNode } from 'react';

export type PreloadableComponent<P> = ComponentType<P> & {
  readonly preload: () => Promise<ComponentType<P>>;
};

export function lazyComponent<P extends object>(
  loader: () => Promise<ComponentType<P>>,
  fallback: ReactNode = null,
): PreloadableComponent<P> {
  let resolved: ComponentType<P> | null = null;
  let flight: Promise<ComponentType<P>> | null = null;

  const preload = (): Promise<ComponentType<P>> => {
    if (resolved !== null) return Promise.resolve(resolved);
    flight ??= loader().then((comp) => {
      resolved = comp;
      return comp;
    });
    return flight;
  };

  function LazyLoadedComponent(props: P) {
    const [, setTick] = useState(0);
    useEffect(() => {
      if (resolved !== null) return;
      let cancelled = false;
      void preload().then(() => {
        if (!cancelled) setTick((value) => value + 1);
      });
      return () => {
        cancelled = true;
      };
    }, []);

    if (resolved === null) {
      void preload();
      return <>{fallback}</>;
    }
    const Component = resolved;
    return <Component {...props} />;
  }

  return Object.assign(LazyLoadedComponent, { preload });
}
