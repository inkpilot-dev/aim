import { useEffect } from 'react';
import { useStore } from '../state/store';
import { IconX } from './Icons';

const TTL: Record<string, number> = { info: 5000, success: 4000, warning: 7000, error: 9000 };

export function Toasts() {
  const { state, dispatch } = useStore();
  const ids = state.toasts.map((t) => t.id).join(',');

  useEffect(() => {
    const timers = state.toasts.map((t) => window.setTimeout(() => dispatch({ type: 'toast.remove', id: t.id }), TTL[t.level] ?? 5000));
    return () => timers.forEach((t) => window.clearTimeout(t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);

  if (!state.toasts.length) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {state.toasts.map((t) => (
        <div key={t.id} className={`toast ${t.level}`}>
          <div className="grow">
            <div className="toast-title">{t.title}</div>
            {t.body ? <div className="toast-body">{t.body}</div> : null}
          </div>
          <button className="icon-btn toast-close" onClick={() => dispatch({ type: 'toast.remove', id: t.id })} aria-label="Dismiss">
            <IconX size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
