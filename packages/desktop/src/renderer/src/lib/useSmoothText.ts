import { useEffect, useRef, useState } from 'react';

/**
 * Smooths streamed text so it appears to type rather than jump in chunks: the displayed text catches up
 * with the target a few characters per animation frame, faster the further behind it is, so it converges
 * within roughly half a second of each delta while still looking continuous.
 * Text that is already complete on mount (a loaded chat) is shown at once.
 */
export function useSmoothText(target: string): string {
  const [shown, setShown] = useState(target);
  const shownRef = useRef(target);

  useEffect(() => {
    const cur = shownRef.current;
    if (cur === target) return;
    // Anything other than an append (edit, reset, different message) is shown immediately.
    if (!target.startsWith(cur)) {
      shownRef.current = target;
      setShown(target);
      return;
    }
    let raf = 0;
    const step = () => {
      const have = shownRef.current.length;
      if (have >= target.length) return;
      const remaining = target.length - have;
      // Between 1 and 14 characters per frame: quick enough to keep up with the model, slow enough to read as typing.
      const n = Math.min(14, Math.max(1, Math.ceil(remaining / 10)));
      const next = target.slice(0, have + n);
      shownRef.current = next;
      setShown(next);
      if (next.length < target.length) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);

  return shown;
}
