import { useEffect } from 'react';
import type { Action } from './reducer';

/** Subscribes once to window.aim chat + global events and forwards them to the reducer. */
export function useChatStream(dispatch: (a: Action) => void): void {
  useEffect(() => {
    if (!window.aim) return;
    const offChat = window.aim.onChatEvent((event) => dispatch({ type: 'chatEvent', event }));
    const offGlobal = window.aim.onGlobalEvent((event) => dispatch({ type: 'globalEvent', event }));
    return () => {
      offChat();
      offGlobal();
    };
  }, [dispatch]);
}
