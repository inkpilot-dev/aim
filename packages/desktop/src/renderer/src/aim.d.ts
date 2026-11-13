import type { AimApi } from '@aim/shared';

declare global {
  interface Window {
    aim: AimApi & {
      platform: string;
      /** Tells the main process the interface rendered (startup watchdog). Absent in the browser preview. */
      rendererReady?: () => void;
      /** Writes an interface error to A.I.M.'s log. Absent in the browser preview. */
      reportError?: (text: string) => void;
    };
  }
}

export {};
