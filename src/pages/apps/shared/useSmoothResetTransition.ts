import { useCallback, useEffect, useState } from 'react';

type TransitionPhase = 'idle' | 'exiting' | 'entering';

type SmoothResetOptions = {
  exitMs?: number;
  enterMs?: number;
};

const DEFAULT_EXIT_MS = 180;
const DEFAULT_ENTER_MS = 220;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function waitForPaint(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

export function useSmoothResetTransition(
  options?: SmoothResetOptions
): {
  contentClassName: string;
  runSmoothReset: (task: () => Promise<void> | void) => Promise<void>;
} {
  const exitMs = options?.exitMs ?? DEFAULT_EXIT_MS;
  const enterMs = options?.enterMs ?? DEFAULT_ENTER_MS;
  const [phase, setPhase] = useState<TransitionPhase>('idle');
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;

    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const applyPreference = () => setReducedMotion(mediaQuery.matches);

    applyPreference();
    mediaQuery.addEventListener('change', applyPreference);
    return () => mediaQuery.removeEventListener('change', applyPreference);
  }, []);

  const runSmoothReset = useCallback(
    async (task: () => Promise<void> | void) => {
      if (reducedMotion) {
        await task();
        return;
      }

      setPhase('exiting');
      await waitForPaint();
      await sleep(exitMs);

      await task();

      setPhase('entering');
      await waitForPaint();
      await sleep(enterMs);
      setPhase('idle');
    },
    [enterMs, exitMs, reducedMotion]
  );

  const contentClassName =
    phase === 'idle'
      ? 'transform-gpu opacity-100 translate-y-0 scale-[1] blur-0'
      : phase === 'exiting'
        ? 'transform-gpu opacity-0 translate-y-3 scale-[0.985] blur-[1px]'
        : 'transform-gpu opacity-100 translate-y-0 scale-[1] blur-0';

  return {
    contentClassName: `transition-[opacity,transform,filter] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform ${contentClassName}`,
    runSmoothReset,
  };
}
