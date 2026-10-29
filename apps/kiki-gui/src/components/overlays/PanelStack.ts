/**
 * Step state for push navigation inside one SidePanel (README.md, side panel
 * tier). A deeper step replaces the panel body; Back pops one step. The panel
 * itself never stacks a second panel or dialog.
 *
 *   const stack = usePanelStack<Step>({ kind: 'pick' });
 *   <SidePanel title={titleOf(stack.top)} stepKey={stack.key}
 *     back={stack.depth > 1 ? { label: t('common.back'), onClick: stack.pop } : undefined}>
 *     {stack.top.kind === 'pick' ? <Grid onPick={(id) => stack.push({ kind: 'form', id })} /> : <Form … />}
 *   </SidePanel>
 */

import { useCallback, useMemo, useState } from 'react';

export interface PanelStack<Step> {
  readonly top: Step;
  readonly depth: number;
  /** Changes on every push/pop; pass to SidePanel `stepKey`. */
  readonly key: string;
  readonly push: (step: Step) => void;
  readonly pop: () => void;
  /** Replace the top step (a choice that refines the current one). */
  readonly replace: (step: Step) => void;
  readonly reset: () => void;
}

export function usePanelStack<Step>(root: Step): PanelStack<Step> {
  const [steps, setSteps] = useState<readonly Step[]>([root]);
  const push = useCallback((step: Step) => { setSteps((current) => [...current, step]); }, []);
  const pop = useCallback(() => { setSteps((current) => current.length > 1 ? current.slice(0, -1) : current); }, []);
  const replace = useCallback((step: Step) => { setSteps((current) => [...current.slice(0, -1), step]); }, []);
  const reset = useCallback(() => { setSteps([root]); }, [root]);
  return useMemo(() => ({
    top: steps.at(-1)!,
    depth: steps.length,
    key: `step-${steps.length}`,
    push, pop, replace, reset,
  }), [steps, push, pop, replace, reset]);
}
