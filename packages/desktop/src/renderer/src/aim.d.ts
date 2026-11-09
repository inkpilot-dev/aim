import type { AimApi } from '@aim/shared';

declare global {
  interface Window {
    aim: AimApi & { platform: string };
  }
}

export {};
